"""MLX port of MOSS-SoundEffect v2.0 (OpenMOSS-Team/MOSS-SoundEffect-v2.0).

A text-to-audio flow-matching DiT (Wan-style, 1.3B) over the 128-d latents of a continuous DAC VAE at 48 kHz,
conditioned on the last hidden state of Qwen3-1.7B. Ported from the reference PyTorch code in
github.com/OpenMOSS/MOSS-TTS/tree/main/moss_soundeffect_v2 (pipeline_moss_soundeffect.py,
diffsynth/models/wan_audio_dit.py, wan_video_dit.py, dac_vae.py, schedulers/flow_match.py).

Everything runs channel-last ([batch, time, channels]). No torch needed: the VAE checkpoint is a pickled
torch module, read here with a restricted unpickler that only rebuilds tensors and never runs code from the file.

The object returned by load() mimics the mlx_audio model interface moss_core uses: generate(**kw) yields
results with .audio and .sample_rate.
"""
from __future__ import annotations

import html
import json
import math
import pickle
import re
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import mlx.core as mx
import mlx.nn as nn
import numpy as np

REPO = "OpenMOSS-Team/MOSS-SoundEffect-v2.0"
TEXT_LEN = 512  # WanPrompter pads/truncates every prompt to this many tokens

# Model-card defaults.
DEFAULT_STEPS = 100
DEFAULT_CFG = 4.0
DEFAULT_SHIFT = 5.0


# ============================================================ Qwen3 text encoder

class _QwenAttention(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.n_heads, self.n_kv, self.head_dim = c["num_attention_heads"], c["num_key_value_heads"], c["head_dim"]
        d = c["hidden_size"]
        self.q_proj = nn.Linear(d, self.n_heads * self.head_dim, bias=c.get("attention_bias", False))
        self.k_proj = nn.Linear(d, self.n_kv * self.head_dim, bias=c.get("attention_bias", False))
        self.v_proj = nn.Linear(d, self.n_kv * self.head_dim, bias=c.get("attention_bias", False))
        self.o_proj = nn.Linear(self.n_heads * self.head_dim, d, bias=False)
        self.q_norm = nn.RMSNorm(self.head_dim, eps=c["rms_norm_eps"])
        self.k_norm = nn.RMSNorm(self.head_dim, eps=c["rms_norm_eps"])
        self.theta = c["rope_theta"]

    def __call__(self, x):
        B, L, _ = x.shape
        q = self.q_norm(self.q_proj(x).reshape(B, L, self.n_heads, -1)).transpose(0, 2, 1, 3)
        k = self.k_norm(self.k_proj(x).reshape(B, L, self.n_kv, -1)).transpose(0, 2, 1, 3)
        v = self.v_proj(x).reshape(B, L, self.n_kv, -1).transpose(0, 2, 1, 3)
        q = mx.fast.rope(q, self.head_dim, traditional=False, base=self.theta, scale=1.0, offset=0)
        k = mx.fast.rope(k, self.head_dim, traditional=False, base=self.theta, scale=1.0, offset=0)
        o = mx.fast.scaled_dot_product_attention(q, k, v, scale=self.head_dim ** -0.5, mask="causal")
        return self.o_proj(o.transpose(0, 2, 1, 3).reshape(B, L, -1))


class _QwenMLP(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.gate_proj = nn.Linear(c["hidden_size"], c["intermediate_size"], bias=False)
        self.up_proj = nn.Linear(c["hidden_size"], c["intermediate_size"], bias=False)
        self.down_proj = nn.Linear(c["intermediate_size"], c["hidden_size"], bias=False)

    def __call__(self, x):
        return self.down_proj(nn.silu(self.gate_proj(x)) * self.up_proj(x))


class _QwenLayer(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.self_attn = _QwenAttention(c)
        self.mlp = _QwenMLP(c)
        self.input_layernorm = nn.RMSNorm(c["hidden_size"], eps=c["rms_norm_eps"])
        self.post_attention_layernorm = nn.RMSNorm(c["hidden_size"], eps=c["rms_norm_eps"])

    def __call__(self, x):
        x = x + self.self_attn(self.input_layernorm(x))
        return x + self.mlp(self.post_attention_layernorm(x))


class _QwenModel(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.embed_tokens = nn.Embedding(c["vocab_size"], c["hidden_size"])
        self.layers = [_QwenLayer(c) for _ in range(c["num_hidden_layers"])]
        self.norm = nn.RMSNorm(c["hidden_size"], eps=c["rms_norm_eps"])

    def __call__(self, ids):
        x = self.embed_tokens(ids)
        for layer in self.layers:
            x = layer(x)
        return self.norm(x)  # == HF hidden_states[-1] (taken after the final norm)


class Qwen3TextEncoder(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.model = _QwenModel(c)


# ============================================================ Wan audio DiT

def _sinusoidal(dim: int, t: mx.array) -> mx.array:
    """sinusoidal_embedding_1d: [cos | sin], computed in float32 (torch uses float64)."""
    half = dim // 2
    freqs = np.power(10000.0, -np.arange(half, dtype=np.float64) / half)
    arg = mx.array(np.asarray(t, dtype=np.float64)[:, None] * freqs[None, :], dtype=mx.float32)
    return mx.concatenate([mx.cos(arg), mx.sin(arg)], axis=-1)


class _SelfAttention(nn.Module):
    def __init__(self, dim, heads, eps):
        super().__init__()
        self.heads, self.head_dim = heads, dim // heads
        self.q, self.k, self.v, self.o = (nn.Linear(dim, dim) for _ in range(4))
        self.norm_q = nn.RMSNorm(dim, eps=eps)  # over the full dim, before the head split
        self.norm_k = nn.RMSNorm(dim, eps=eps)

    def __call__(self, x):
        B, L, _ = x.shape
        split = lambda a: a.reshape(B, L, self.heads, self.head_dim).transpose(0, 2, 1, 3)
        q, k, v = split(self.norm_q(self.q(x))), split(self.norm_k(self.k(x))), split(self.v(x))
        # RoPE on adjacent (even, odd) pairs, theta 10000, positions 0..L-1 (the DAC branch of the reference).
        q = mx.fast.rope(q, self.head_dim, traditional=True, base=10000.0, scale=1.0, offset=0)
        k = mx.fast.rope(k, self.head_dim, traditional=True, base=10000.0, scale=1.0, offset=0)
        o = mx.fast.scaled_dot_product_attention(q, k, v, scale=self.head_dim ** -0.5)
        return self.o(o.transpose(0, 2, 1, 3).reshape(B, L, -1))


class _CrossAttention(nn.Module):
    def __init__(self, dim, heads, eps):
        super().__init__()
        self.heads, self.head_dim = heads, dim // heads
        self.q, self.k, self.v, self.o = (nn.Linear(dim, dim) for _ in range(4))
        self.norm_q = nn.RMSNorm(dim, eps=eps)
        self.norm_k = nn.RMSNorm(dim, eps=eps)

    def kv(self, ctx):
        B, S, _ = ctx.shape
        split = lambda a: a.reshape(B, S, self.heads, self.head_dim).transpose(0, 2, 1, 3)
        return split(self.norm_k(self.k(ctx))), split(self.v(ctx))

    def __call__(self, x, kv):
        B, L, _ = x.shape
        q = self.norm_q(self.q(x)).reshape(B, L, self.heads, self.head_dim).transpose(0, 2, 1, 3)
        # No mask: the reference attends over all TEXT_LEN context slots, padding included.
        o = mx.fast.scaled_dot_product_attention(q, kv[0], kv[1], scale=self.head_dim ** -0.5)
        return self.o(o.transpose(0, 2, 1, 3).reshape(B, L, -1))


class _FFN(nn.Module):
    def __init__(self, dim, ffn_dim):
        super().__init__()
        self.layers = [nn.Linear(dim, ffn_dim), nn.Linear(ffn_dim, dim)]

    def __call__(self, x):
        return self.layers[1](nn.gelu_approx(self.layers[0](x)))


class _DiTBlock(nn.Module):
    def __init__(self, dim, heads, ffn_dim, eps):
        super().__init__()
        self.eps = eps
        self.self_attn = _SelfAttention(dim, heads, eps)
        self.cross_attn = _CrossAttention(dim, heads, eps)
        self.norm3 = nn.LayerNorm(dim, eps=eps)  # affine; norm1/norm2 are parameter-free
        self.ffn = _FFN(dim, ffn_dim)
        self.modulation = mx.zeros((1, 6, dim))

    def __call__(self, x, kv, t_mod):
        # x: float32 residual stream. t_mod: [B, 6, dim] float32.
        dt = self.ffn.layers[0].weight.dtype
        mod = self.modulation.astype(mx.float32) + t_mod
        shift_msa, scale_msa, gate_msa, shift_mlp, scale_mlp, gate_mlp = (mod[:, i:i + 1] for i in range(6))
        h = mx.fast.layer_norm(x, None, None, self.eps) * (1 + scale_msa) + shift_msa
        x = x + gate_msa * self.self_attn(h.astype(dt))
        x = x + self.cross_attn(self.norm3(x).astype(dt), kv)
        h = mx.fast.layer_norm(x, None, None, self.eps) * (1 + scale_mlp) + shift_mlp
        return x + gate_mlp * self.ffn(h.astype(dt))


class _Head(nn.Module):
    def __init__(self, dim, out_dim, eps):
        super().__init__()
        self.eps = eps
        self.head = nn.Linear(dim, out_dim)
        self.modulation = mx.zeros((1, 2, dim))

    def __call__(self, x, t):
        mod = self.modulation.astype(mx.float32) + t[:, None, :]
        shift, scale = mod[:, 0:1], mod[:, 1:2]
        h = mx.fast.layer_norm(x, None, None, self.eps) * (1 + scale) + shift
        return self.head(h.astype(self.head.weight.dtype))


class WanAudioDiT(nn.Module):
    def __init__(self, c):
        super().__init__()
        dim, self.freq_dim, self.dim = c["dim"], c["freq_dim"], c["dim"]
        assert list(c.get("patch_size", [1])) == [1], "only patch_size [1] is supported"
        self.patch_embedding = nn.Linear(c["in_dim"], dim)  # Conv1d with kernel 1
        self.text_embedding = [nn.Linear(c["text_dim"], dim), nn.Linear(dim, dim)]
        self.time_embedding = [nn.Linear(c["freq_dim"], dim), nn.Linear(dim, dim)]
        self.time_projection = nn.Linear(dim, dim * 6)
        self.blocks = [_DiTBlock(dim, c["num_heads"], c["ffn_dim"], c["eps"]) for _ in range(c["num_layers"])]
        self.head = _Head(dim, c["out_dim"], c["eps"])

    def embed_context(self, context):
        """Text projection + per-block cross-attention K/V. Constant across steps, so computed once."""
        ctx = self.text_embedding[1](nn.gelu_approx(self.text_embedding[0](context)))
        return [b.cross_attn.kv(ctx) for b in self.blocks]

    def time(self, timestep):
        """timestep: python float (sigma * 1000) -> (t [1, dim], t_mod [1, 6, dim]) in float32."""
        e = _sinusoidal(self.freq_dim, np.array([timestep]))
        l0, l1 = self.time_embedding
        t = e @ l0.weight.astype(mx.float32).T + l0.bias.astype(mx.float32)
        t = nn.silu(t) @ l1.weight.astype(mx.float32).T + l1.bias.astype(mx.float32)
        p = self.time_projection
        t_mod = nn.silu(t) @ p.weight.astype(mx.float32).T + p.bias.astype(mx.float32)
        return t, t_mod.reshape(t.shape[0], 6, self.dim)

    def __call__(self, latents, kvs, t, t_mod):
        """latents [B, T, in_dim]; returns the predicted velocity [B, T, out_dim] in float32."""
        dt = self.patch_embedding.weight.dtype
        x = self.patch_embedding(latents.astype(dt)).astype(mx.float32)
        for block, kv in zip(self.blocks, kvs):
            x = block(x, kv, t_mod)
        return self.head(x, t).astype(mx.float32)


# ============================================================ DAC VAE (decoder only)

class _Conv(nn.Module):
    """Conv1d, channel-last, weight already folded from weight-norm and stored as MLX [out, k, in]."""

    def __init__(self, cin, cout, k, dilation=1, padding=0, stride=1):
        super().__init__()
        self.weight = mx.zeros((cout, k, cin))
        self.bias = mx.zeros((cout,))
        self.dilation, self.padding, self.stride = dilation, padding, stride

    def __call__(self, x):
        return mx.conv1d(x, self.weight, stride=self.stride, padding=self.padding, dilation=self.dilation) + self.bias


class _ConvT(nn.Module):
    """ConvTranspose1d matching torch's padding/output_padding, weight stored as MLX [out, k, in]."""

    def __init__(self, cin, cout, k, stride, padding, output_padding):
        super().__init__()
        self.weight = mx.zeros((cout, k, cin))
        self.bias = mx.zeros((cout,))
        self.k, self.stride, self.padding, self.output_padding = k, stride, padding, output_padding

    def __call__(self, x):
        y = mx.conv_transpose1d(x, self.weight, stride=self.stride, padding=0)
        L = x.shape[1]
        out_len = (L - 1) * self.stride - 2 * self.padding + self.k + self.output_padding
        y = y[:, self.padding:self.padding + out_len]
        if y.shape[1] < out_len:  # output_padding past the full transposed length
            y = mx.pad(y, [(0, 0), (0, out_len - y.shape[1]), (0, 0)])
        return y + self.bias


class _Snake(nn.Module):
    def __init__(self, ch):
        super().__init__()
        self.alpha = mx.ones((ch,))

    def __call__(self, x):
        a = self.alpha
        return x + mx.reciprocal(a + 1e-9) * mx.square(mx.sin(a * x))


class _ResUnit(nn.Module):
    def __init__(self, dim, dilation):
        super().__init__()
        self.block = [_Snake(dim), _Conv(dim, dim, 7, dilation=dilation, padding=3 * dilation), _Snake(dim),
                      _Conv(dim, dim, 1)]

    def __call__(self, x):
        y = x
        for m in self.block:
            y = m(y)
        pad = (x.shape[1] - y.shape[1]) // 2
        if pad > 0:
            x = x[:, pad:-pad]
        return x + y


class _DecoderBlock(nn.Module):
    def __init__(self, cin, cout, stride):
        super().__init__()
        self.block = [_Snake(cin),
                      _ConvT(cin, cout, 2 * stride, stride, math.ceil(stride / 2), stride % 2),
                      _ResUnit(cout, 1), _ResUnit(cout, 3), _ResUnit(cout, 9)]

    def __call__(self, x):
        for m in self.block:
            x = m(x)
        return x


class DACDecoder(nn.Module):
    def __init__(self, latent_dim, channels, rates, continuous):
        super().__init__()
        self.continuous = continuous
        if continuous:
            self.post_quant_conv = _Conv(latent_dim, latent_dim, 1)
        layers = [_Conv(latent_dim, channels, 7, padding=3)]
        out = channels
        for i, s in enumerate(rates):
            cin, out = channels // 2 ** i, channels // 2 ** (i + 1)
            layers.append(_DecoderBlock(cin, out, s))
        layers += [_Snake(out), _Conv(out, 1, 7, padding=3)]
        self.model = layers

    def __call__(self, z):
        if self.continuous:
            z = self.post_quant_conv(z)
        for m in self.model:
            z = m(z)
        return mx.tanh(z)


# ============================================================ restricted torch .pth reader

class _Stub:
    """Stands in for any pickled class; just keeps the state it was given."""

    def __init__(self, *a, **k):
        self._args = a

    def __setstate__(self, state):
        self._state = state

    def __call__(self, *a, **k):  # pickled callables (e.g. hooks) may get "called" during REDUCE
        return _Stub(*a)


_DTYPES = {"FloatStorage": np.float32, "HalfStorage": np.float16, "BFloat16Storage": "bf16",
           "DoubleStorage": np.float64, "LongStorage": np.int64, "IntStorage": np.int32, "BoolStorage": np.bool_}


def _read_pth(path: str):
    """torch.load() replacement for tensors + plain containers. Unknown classes become inert _Stub objects."""
    zf = zipfile.ZipFile(path)
    names = zf.namelist()
    prefix = names[0].split("/")[0]
    storages = {}

    def load_storage(key, dtype):
        if key not in storages:
            raw = zf.read(f"{prefix}/data/{key}")
            if dtype == "bf16":
                u = np.frombuffer(raw, dtype=np.uint16).astype(np.uint32) << 16
                storages[key] = u.view(np.float32)
            else:
                storages[key] = np.frombuffer(raw, dtype=dtype)
        return storages[key]

    def rebuild_tensor(storage, offset, size, stride, *rest):
        if not size:
            return storage[offset:offset + 1].reshape(())
        itemsize = storage.itemsize
        return np.lib.stride_tricks.as_strided(storage[offset:], shape=tuple(size),
                                               strides=tuple(s * itemsize for s in stride)).copy()

    def rebuild_parameter(data, *rest):
        return data

    class U(pickle.Unpickler):
        def find_class(self, module, name):
            if module == "torch._utils" and name == "_rebuild_tensor_v2":
                return rebuild_tensor
            if module == "torch._utils" and name in ("_rebuild_parameter", "_rebuild_parameter_with_state"):
                return rebuild_parameter
            if module == "torch" and name in _DTYPES:
                return name
            if module == "collections" and name == "OrderedDict":
                import collections
                return collections.OrderedDict
            if module == "builtins" and name in ("set", "frozenset", "dict", "list", "tuple", "slice"):
                import builtins
                return getattr(builtins, name)
            return _Stub

        def persistent_load(self, pid):
            _, storage_type, key, _loc, _n = pid
            dt = _DTYPES.get(storage_type if isinstance(storage_type, str) else "FloatStorage", np.float32)
            return load_storage(key, dt)

    with zf.open(f"{prefix}/data.pkl") as f:
        return U(f).load()


def _module_state(obj, prefix="", out=None):
    """Walk a stubbed nn.Module tree into a flat {name: ndarray} state dict (params + buffers)."""
    out = {} if out is None else out
    st = getattr(obj, "_state", None)
    if not isinstance(st, dict):
        return out
    for group in ("_parameters", "_buffers"):
        for k, v in (st.get(group) or {}).items():
            if isinstance(v, np.ndarray):
                out[prefix + k] = v
    for k, m in (st.get("_modules") or {}).items():
        if m is not None:
            _module_state(m, f"{prefix}{k}.", out)
    return out


def _fold_weight_norm(sd: dict) -> dict:
    """weight_g/weight_v (old API) or parametrizations.weight.original0/1 (new) -> plain weight."""
    out = {}
    for k, v in sd.items():
        for g_suf, v_suf, w_name in ((".weight_g", ".weight_v", ".weight"),
                                     (".parametrizations.weight.original0", ".parametrizations.weight.original1",
                                      ".weight")):
            if k.endswith(g_suf):
                base = k[: -len(g_suf)]
                vv = sd[base + v_suf].astype(np.float32)
                g = v.astype(np.float32)
                norm = np.sqrt((vv ** 2).sum(axis=tuple(range(1, vv.ndim)), keepdims=True))
                out[base + w_name] = g * vv / norm
                break
            if k.endswith(v_suf):
                break
        else:
            out[k] = v
    return out


def load_dac_decoder(path: str) -> tuple[DACDecoder, int, int]:
    """Returns (decoder, hop_length, sample_rate)."""
    obj = _read_pth(path)
    if isinstance(obj, dict) and "state_dict" in obj:  # audiotools BaseModel.save() format
        sd = dict(obj["state_dict"])
        kw = (obj.get("metadata") or {}).get("kwargs") or {}
        attrs = dict(kw)
    else:
        sd = _module_state(obj)
        attrs = {k: v for k, v in (getattr(obj, "_state", {}) or {}).items() if not k.startswith("_")}
    sd = _fold_weight_norm(sd)
    enc_rates = list(attrs.get("encoder_rates") or [2, 4, 8, 8])
    dec_rates = list(attrs.get("decoder_rates") or [8, 8, 4, 2])
    dec_dim = int(attrs.get("decoder_dim") or 1536)
    latent_dim = int(attrs.get("latent_dim") or 128)
    sr = int(attrs.get("sample_rate") or 48000)
    continuous = bool(attrs.get("continuous", "post_quant_conv.weight" in sd))
    dec = DACDecoder(latent_dim, dec_dim, dec_rates, continuous)

    weights = []
    for k, v in sd.items():
        if not (k.startswith("decoder.") or k.startswith("post_quant_conv.")):
            continue
        name = k[len("decoder."):] if k.startswith("decoder.") else k
        v = v.astype(np.float32)
        if name.endswith(".alpha"):
            v = v.reshape(-1)
        elif name.endswith(".weight") and v.ndim == 3:
            if ".block.1." in name and _is_convt(dec, name):
                v = v.transpose(1, 2, 0)  # ConvTranspose1d [in, out, k] -> [out, k, in]
            else:
                v = v.transpose(0, 2, 1)  # Conv1d [out, in, k] -> [out, k, in]
        weights.append((name, mx.array(v)))
    dec.load_weights(weights, strict=True)
    return dec, int(np.prod(enc_rates)), sr


def _is_convt(dec, name):
    obj = dec
    for p in name.split(".")[:-1]:
        obj = obj[int(p)] if p.isdigit() else getattr(obj, p)
    return isinstance(obj, _ConvT)


# ============================================================ pipeline

def _clean(text: str) -> str:
    try:
        import ftfy
        text = ftfy.fix_text(text)
    except ImportError:
        pass
    text = html.unescape(html.unescape(text)).strip()
    return re.sub(r"\s+", " ", text).strip()


def flow_sigmas(steps: int, shift: float) -> np.ndarray:
    """FlowMatchScheduler(sigma_min=0, extra_one_step=True) with the classic shift."""
    s = np.linspace(1.0, 0.0, steps + 1, dtype=np.float32)[:-1]
    return shift * s / (1 + (shift - 1) * s)


@dataclass
class Result:
    audio: np.ndarray
    sample_rate: int
    samples: int
    processing_time_seconds: float


class MossSoundEffectV2:
    step_callbacks = True  # moss_core.render passes should_cancel through

    def __init__(self, model_dir: Path, dtype=mx.bfloat16):
        from transformers import AutoTokenizer

        self.model_dir = Path(model_dir)
        index = json.loads((self.model_dir / "model_index.json").read_text())
        self.sample_rate = int(index.get("sample_rate", 48000))
        self.max_seconds = int(index.get("max_inference_seconds", 30))
        sched = json.loads((self.model_dir / "scheduler" / "scheduler_config.json").read_text())
        self.default_shift = float(sched.get("shift", DEFAULT_SHIFT))

        self.tokenizer = AutoTokenizer.from_pretrained(str(self.model_dir / "tokenizer"))

        te_dir = self.model_dir / "text_encoder"
        te_cfg = json.loads((te_dir / "config.json").read_text())
        self.text_encoder = Qwen3TextEncoder(te_cfg)
        w = {}
        for f in sorted(te_dir.glob("*.safetensors")):
            w.update({k: v for k, v in mx.load(str(f)).items() if not k.startswith("lm_head.")})
        self.text_encoder.load_weights([(k, v.astype(dtype)) for k, v in w.items()], strict=True)
        self.text_encoder.eval()

        dit_cfg = json.loads((self.model_dir / "transformer" / "config.json").read_text())
        self.dit = WanAudioDiT(dit_cfg)
        self.dit.load_weights(self._dit_weights(dtype), strict=True)
        self.dit.eval()
        self.latent_dim = dit_cfg["in_dim"]

        self.vae, self.hop, vae_sr = load_dac_decoder(str(self.model_dir / "vae" / "vae_128d_48k.pth"))
        self.vae.eval()
        if vae_sr != self.sample_rate:
            raise ValueError(f"VAE sample rate {vae_sr} != pipeline {self.sample_rate}")
        mx.eval(self.text_encoder.parameters(), self.dit.parameters(), self.vae.parameters())

    def _dit_weights(self, dtype):
        raw = mx.load(str(self.model_dir / "transformer" / "diffusion_pytorch_model.safetensors"))
        glob = {
            "condition_embedder.text_embedder.linear_1": "text_embedding.0",
            "condition_embedder.text_embedder.linear_2": "text_embedding.1",
            "condition_embedder.time_embedder.linear_1": "time_embedding.0",
            "condition_embedder.time_embedder.linear_2": "time_embedding.1",
            "condition_embedder.time_proj": "time_projection",
            "proj_out": "head.head",
            "patch_embedding": "patch_embedding",
            # already-converted (DiffSynth) names, in case the checkpoint uses them
            "text_embedding.0": "text_embedding.0", "text_embedding.2": "text_embedding.1",
            "time_embedding.0": "time_embedding.0", "time_embedding.2": "time_embedding.1",
            "time_projection.1": "time_projection", "head.head": "head.head",
        }
        block = {
            "attn1.norm_q": "self_attn.norm_q", "attn1.norm_k": "self_attn.norm_k",
            "attn1.to_q": "self_attn.q", "attn1.to_k": "self_attn.k", "attn1.to_v": "self_attn.v",
            "attn1.to_out.0": "self_attn.o",
            "attn2.norm_q": "cross_attn.norm_q", "attn2.norm_k": "cross_attn.norm_k",
            "attn2.to_q": "cross_attn.q", "attn2.to_k": "cross_attn.k", "attn2.to_v": "cross_attn.v",
            "attn2.to_out.0": "cross_attn.o",
            "ffn.net.0.proj": "ffn.layers.0", "ffn.net.2": "ffn.layers.1",
            "ffn.0": "ffn.layers.0", "ffn.2": "ffn.layers.1",
            "norm2": "norm3",  # diffusers norm2 is the affine cross-attn norm (DiffSynth norm3)
        }
        out = []
        for k, v in raw.items():
            name = None
            if k in ("scale_shift_table", "head.modulation"):
                name = "head.modulation"
            elif k.startswith("blocks."):
                _, idx, rest = k.split(".", 2)
                if rest in ("scale_shift_table", "modulation"):
                    name = f"blocks.{idx}.modulation"
                else:
                    mod, param = rest.rsplit(".", 1)
                    name = f"blocks.{idx}.{block.get(mod, mod)}.{param}"
            else:
                mod, param = k.rsplit(".", 1)
                if mod in glob:
                    name = f"{glob[mod]}.{param}"
            if name is None:
                raise KeyError(f"unmapped DiT weight {k}")
            if name == "patch_embedding.weight":
                v = v.reshape(v.shape[0], v.shape[1])  # Conv1d k=1 -> Linear
            out.append((name, v.astype(mx.float32) if "modulation" in name else v.astype(dtype)))
        return out

    # ---- text

    def encode_prompt(self, prompt: str) -> mx.array:
        """[1, TEXT_LEN, 2048]: Qwen3 last hidden state of the real tokens, zeros for the padding."""
        ids = self.tokenizer(_clean(prompt), add_special_tokens=True, truncation=True,
                             max_length=TEXT_LEN)["input_ids"]
        dim = self.text_encoder.model.norm.weight.shape[0]
        ctx = mx.zeros((1, TEXT_LEN, dim), dtype=mx.bfloat16)
        if ids:
            h = self.text_encoder.model(mx.array([ids]))
            ctx = mx.concatenate([h.astype(mx.bfloat16), ctx[:, len(ids):]], axis=1)
        return ctx

    # ---- generation

    def generate(self, prompt: str | None = None, seconds: float = 10.0, steps: int = DEFAULT_STEPS,
                 cfg_scale: float = DEFAULT_CFG, shift: float | None = None, seed: int | None = None,
                 negative_prompt: str = "", append_duration: bool = True, full_length: bool = True,
                 crop: bool = True,
                 on_step: Callable[[int, int], None] | None = None,
                 should_cancel: Callable[[], bool] | None = None, stream: bool = False,
                 ambient_sound: str | None = None, **_ignored):
        prompt = (prompt or ambient_sound or "").strip()
        if not prompt:
            raise ValueError("prompt is empty")
        seconds = round(float(seconds), 1)
        if not 0 < seconds <= self.max_seconds:
            raise ValueError(f"seconds must be in (0, {self.max_seconds}]")
        shift = self.default_shift if shift is None else float(shift)
        t0 = time.perf_counter()
        text = f"{prompt} duration: {seconds:.1f}s" if append_duration else prompt

        # The reference always denoises a full max_seconds latent and crops; full_length=False denoises only
        # what's needed (faster for short sounds, but off the trained distribution).
        span = self.max_seconds if full_length else seconds
        frames = int(self.sample_rate * span) // self.hop

        pos = self.encode_prompt(text)
        neg = self.encode_prompt(negative_prompt)
        use_cfg = cfg_scale != 1.0
        context = mx.concatenate([pos, neg], axis=0) if use_cfg else pos
        kvs = self.dit.embed_context(context)
        mx.eval(kvs)

        key = mx.random.key(seed) if seed is not None else None
        x = mx.random.normal((1, frames, self.latent_dim), dtype=mx.float32, key=key)

        sigmas = flow_sigmas(int(steps), shift)
        for i, sigma in enumerate(sigmas):
            if should_cancel and should_cancel():
                from moss_core import Cancelled  # only reachable under the server
                raise Cancelled()
            t, t_mod = self.dit.time(float(sigma) * 1000.0)
            xin = mx.concatenate([x, x], axis=0) if use_cfg else x
            v = self.dit(xin, kvs, t, t_mod)
            if use_cfg:
                v = v[1:2] + cfg_scale * (v[0:1] - v[1:2])
            nxt = float(sigmas[i + 1]) if i + 1 < len(sigmas) else 0.0
            x = x + v * (nxt - float(sigma))
            mx.eval(x)
            if on_step:
                on_step(i + 1, len(sigmas))

        del kvs
        audio = self.vae(x)  # [1, frames*hop, 1]
        end = int(self.sample_rate * seconds) if crop else audio.shape[1]
        audio = np.asarray(audio[0, :end, 0].astype(mx.float32))
        mx.clear_cache()
        yield Result(audio=audio, sample_rate=self.sample_rate, samples=len(audio),
                     processing_time_seconds=time.perf_counter() - t0)


def load(repo_or_dir: str = REPO) -> MossSoundEffectV2:
    p = Path(repo_or_dir)
    if not p.is_dir():
        from huggingface_hub import snapshot_download
        p = Path(snapshot_download(repo_or_dir))
    return MossSoundEffectV2(p)


if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="MOSS-SoundEffect v2.0 on MLX")
    ap.add_argument("prompt")
    ap.add_argument("-o", "--out", default="sfx_v2.wav")
    ap.add_argument("--seconds", type=float, default=10.0)
    ap.add_argument("--steps", type=int, default=DEFAULT_STEPS)
    ap.add_argument("--cfg", type=float, default=DEFAULT_CFG)
    ap.add_argument("--shift", type=float, default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--short", action="store_true", help="denoise only `seconds` instead of the full 30 s")
    ap.add_argument("--model", default=REPO)
    a = ap.parse_args()
    t = time.perf_counter()
    m = load(a.model)
    print(f"loaded in {time.perf_counter() - t:.1f}s", file=sys.stderr)
    mx.reset_peak_memory()
    r = next(m.generate(a.prompt, seconds=a.seconds, steps=a.steps, cfg_scale=a.cfg, shift=a.shift, seed=a.seed,
                        full_length=not a.short,
                        on_step=lambda i, n: print(f"\rstep {i}/{n}", end="", file=sys.stderr)))
    print(f"\n{r.processing_time_seconds:.1f}s, peak {mx.get_peak_memory() / 1e9:.1f} GB", file=sys.stderr)
    from mlx_audio.audio_io import write as audio_write
    audio_write(a.out, r.audio, r.sample_rate, format="wav")
    print(a.out)
