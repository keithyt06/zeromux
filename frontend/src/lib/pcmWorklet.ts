/**
 * Source for the AudioWorkletProcessor that downsamples to 16kHz Int16 PCM.
 * Loaded at runtime via:
 *   const url = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' }))
 *   await audioContext.audioWorklet.addModule(url)
 *
 * Posts ArrayBuffer chunks (Int16, little-endian) to the main thread, ~100ms each.
 */
export const PCM_WORKLET_SOURCE = `
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this._targetRate = 16000
    this._buffer = []
    this._chunkSamples = 1600
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true

    const sourceRate = sampleRate
    const ratio = sourceRate / this._targetRate

    const targetLen = Math.floor(ch.length / ratio)
    const out = new Float32Array(targetLen)
    for (let i = 0; i < targetLen; i++) {
      const srcIdx = i * ratio
      const lo = Math.floor(srcIdx)
      const hi = Math.min(lo + 1, ch.length - 1)
      const frac = srcIdx - lo
      out[i] = ch[lo] * (1 - frac) + ch[hi] * frac
    }

    for (let i = 0; i < out.length; i++) this._buffer.push(out[i])
    while (this._buffer.length >= this._chunkSamples) {
      const slice = this._buffer.splice(0, this._chunkSamples)
      const pcm = new Int16Array(slice.length)
      for (let i = 0; i < slice.length; i++) {
        const s = Math.max(-1, Math.min(1, slice[i]))
        pcm[i] = (s * 0x7fff) | 0
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer])
    }
    return true
  }
}
registerProcessor('pcm-worklet', PcmWorklet)
`
