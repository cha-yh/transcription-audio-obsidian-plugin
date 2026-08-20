import {
  analyzeSpeechActivity,
  SpeechActivityResult,
} from "../../utils/speechActivity";

export interface WavHeader {
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

/** Every WAV this plugin writes uses the canonical 44-byte header. */
const WAV_HEADER_BYTES = 44;

export class AudioService {
  parseWavHeader(buffer: ArrayBuffer): WavHeader {
    const view = new DataView(buffer);
    const readTag = (offset: number) =>
      String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );

    if (readTag(0) !== "RIFF" || readTag(8) !== "WAVE") {
      throw new Error("Unsupported WAV: Missing RIFF/WAVE header");
    }

    let fmtFound = false;
    let dataFound = false;
    let offset = 12;

    let audioFormat = 1;
    let numChannels = 1;
    let sampleRate = 16000;
    let bitsPerSample = 16;
    let dataOffset = 0;
    let dataSize = 0;

    while (offset + 8 <= view.byteLength) {
      const chunkId = readTag(offset);
      const chunkSize = view.getUint32(offset + 4, true);
      const next = offset + 8 + chunkSize + (chunkSize % 2);

      if (chunkId === "fmt ") {
        audioFormat = view.getUint16(offset + 8, true);
        numChannels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true);
        fmtFound = true;
      } else if (chunkId === "data") {
        dataOffset = offset + 8;
        dataSize = chunkSize;
        dataFound = true;
      }

      offset = next;
      if (fmtFound && dataFound) break;
    }

    if (!fmtFound || !dataFound) {
      throw new Error("Unsupported WAV: Missing fmt or data chunk");
    }

    return {
      audioFormat,
      numChannels,
      sampleRate,
      bitsPerSample,
      dataOffset,
      dataSize,
    };
  }

  /**
   * Estimates where speech actually occurs in an already-decoded PCM16 WAV,
   * so chunks that contain only room noise can be surfaced before they are
   * sent to the model.
   */
  analyzeWavSpeechActivity(buffer: ArrayBuffer): SpeechActivityResult {
    const { audioFormat, numChannels, sampleRate, bitsPerSample, dataOffset, dataSize } =
      this.parseWavHeader(buffer);

    if (audioFormat !== 1 || bitsPerSample !== 16) {
      throw new Error(
        `Only PCM 16-bit WAV can be analysed (format=${audioFormat}, bps=${bitsPerSample})`
      );
    }

    const byteLength = Math.min(dataSize, buffer.byteLength - dataOffset);
    const sampleCount = Math.floor(byteLength / 2);
    // Int16Array needs a 2-byte-aligned offset; data chunks usually start at
    // an even offset but nothing in the format guarantees it.
    const samples =
      dataOffset % 2 === 0
        ? new Int16Array(buffer, dataOffset, sampleCount)
        : new Int16Array(
            buffer.slice(dataOffset, dataOffset + sampleCount * 2)
          );

    return analyzeSpeechActivity({ samples, sampleRate, numChannels });
  }

  sliceWavPcm16(
    buffer: ArrayBuffer,
    startMs: number,
    endMs?: number
  ): ArrayBuffer {
    const header = this.parseWavHeader(buffer);
    const { startByte, dataSize } = this.computeWavSliceBytes(
      header,
      startMs,
      endMs
    );

    const out = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
    this.writeWavHeader(new DataView(out), header, dataSize);

    const src = new Uint8Array(buffer, startByte, dataSize);
    new Uint8Array(out, WAV_HEADER_BYTES, dataSize).set(src);

    return out;
  }

  /**
   * Same slice as sliceWavPcm16, but the audio is referenced rather than
   * copied: only the 44-byte header is allocated and the rest is a Blob view of
   * the source. A 20 minute chunk costs 38 MB as an ArrayBuffer and nothing
   * here, which is what makes several chunks in flight affordable on a phone.
   */
  sliceWavPcm16ToBlob(
    wav: Blob,
    header: WavHeader,
    startMs: number,
    endMs?: number
  ): Blob {
    const { startByte, endByte, dataSize } = this.computeWavSliceBytes(
      header,
      startMs,
      endMs
    );

    const headerBuffer = new ArrayBuffer(WAV_HEADER_BYTES);
    this.writeWavHeader(new DataView(headerBuffer), header, dataSize);

    return new Blob([headerBuffer, wav.slice(startByte, endByte)], {
      type: "audio/wav",
    });
  }

  /** Byte range of [startMs, endMs) within a PCM16 WAV's data section. */
  private computeWavSliceBytes(
    header: WavHeader,
    startMs: number,
    endMs?: number
  ): { startByte: number; endByte: number; dataSize: number } {
    const {
      audioFormat,
      numChannels,
      sampleRate,
      bitsPerSample,
      dataOffset,
      dataSize,
    } = header;

    if (audioFormat !== 1 || bitsPerSample !== 16) {
      throw new Error(
        `Only PCM 16-bit WAV is supported for chunking (format=${audioFormat}, bps=${bitsPerSample})`
      );
    }

    const bytesPerFrame = numChannels * (bitsPerSample / 8);
    const totalFrames = Math.floor(dataSize / bytesPerFrame);
    const totalMs = Math.floor((totalFrames / sampleRate) * 1000);

    const sMs = Math.max(0, Math.min(startMs, totalMs));
    const eMs =
      endMs == null ? totalMs : Math.max(sMs, Math.min(endMs, totalMs));

    const startByte =
      dataOffset + Math.floor((sMs / 1000) * sampleRate) * bytesPerFrame;
    const endByte =
      dataOffset + Math.floor((eMs / 1000) * sampleRate) * bytesPerFrame;

    return { startByte, endByte, dataSize: Math.max(0, endByte - startByte) };
  }

  /** Writes the 44-byte canonical PCM16 header describing `dataSize` bytes. */
  private writeWavHeader(
    view: DataView,
    header: Pick<WavHeader, "numChannels" | "sampleRate" | "bitsPerSample">,
    dataSize: number
  ): void {
    const { numChannels, sampleRate, bitsPerSample } = header;
    const bytesPerFrame = numChannels * (bitsPerSample / 8);

    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    this.writeString(view, 8, "WAVE");
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerFrame, true);
    view.setUint16(32, bytesPerFrame, true);
    view.setUint16(34, bitsPerSample, true);
    this.writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);
  }

  async decodeToWavPcm16(
    audioBuffer: ArrayBuffer,
    targetSampleRate: number = 16000
  ): Promise<{ wavBuffer: ArrayBuffer; durationMs: number }> {
    // Not resumed on purpose: decodeAudioData works on a suspended context, and
    // resume() waits for a user gesture on iOS — where it does not reject, it
    // stays pending, leaving the run stuck with nothing to show for it.
    const audioContext = new AudioContext();
    try {
      const decodedBuffer = await audioContext.decodeAudioData(
        audioBuffer.slice(0)
      );

      const durationMs = Math.floor(decodedBuffer.duration * 1000);

      const totalSamples = Math.ceil(
        decodedBuffer.duration * targetSampleRate
      );
      const offlineCtx = new OfflineAudioContext(
        1,
        totalSamples,
        targetSampleRate
      );

      const source = offlineCtx.createBufferSource();
      source.buffer = decodedBuffer;
      source.connect(offlineCtx.destination);
      source.start(0);

      const renderedBuffer = await offlineCtx.startRendering();
      const pcmData = renderedBuffer.getChannelData(0);

      const wavBuffer = this.createWavFromFloat32Pcm(pcmData, targetSampleRate);
      return { wavBuffer, durationMs };
    } finally {
      await audioContext.close();
    }
  }

  private createWavFromFloat32Pcm(
    pcmData: Float32Array,
    sampleRate: number
  ): ArrayBuffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const dataSize = pcmData.length * (bitsPerSample / 8);
    const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
    const view = new DataView(buffer);

    this.writeWavHeader(view, { numChannels, sampleRate, bitsPerSample }, dataSize);

    let offset = WAV_HEADER_BYTES;
    for (let i = 0; i < pcmData.length; i++) {
      const s = Math.max(-1, Math.min(1, pcmData[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }

    return buffer;
  }

  private writeString(view: DataView, offset: number, string: string): void {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}
