export class AudioService {
  arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  async arrayBufferToBase64Async(buffer: ArrayBuffer): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      try {
        const blob = new Blob([buffer]);
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const commaIndex = dataUrl.indexOf(",");
          resolve(
            commaIndex >= 0 ? dataUrl.substring(commaIndex + 1) : dataUrl
          );
        };
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(blob);
      } catch (e) {
        reject(e);
      }
    });
  }

  parseWavHeader(buffer: ArrayBuffer): {
    audioFormat: number;
    numChannels: number;
    sampleRate: number;
    bitsPerSample: number;
    dataOffset: number;
    dataSize: number;
  } {
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

  sliceWavPcm16(
    buffer: ArrayBuffer,
    startMs: number,
    endMs?: number
  ): ArrayBuffer {
    const {
      audioFormat,
      numChannels,
      sampleRate,
      bitsPerSample,
      dataOffset,
      dataSize,
    } = this.parseWavHeader(buffer);

    if (audioFormat !== 1 || bitsPerSample !== 16) {
      throw new Error(
        `Only PCM 16-bit WAV is supported for chunking (format=${audioFormat}, bps=${bitsPerSample})`
      );
    }

    const bytesPerSample = bitsPerSample / 8;
    const bytesPerFrame = numChannels * bytesPerSample;
    const totalFrames = Math.floor(dataSize / bytesPerFrame);
    const totalMs = Math.floor((totalFrames / sampleRate) * 1000);

    const sMs = Math.max(0, Math.min(startMs, totalMs));
    const eMs =
      endMs == null ? totalMs : Math.max(sMs, Math.min(endMs, totalMs));

    const startFrame = Math.floor((sMs / 1000) * sampleRate);
    const endFrame = Math.floor((eMs / 1000) * sampleRate);

    const startByte = dataOffset + startFrame * bytesPerFrame;
    const endByte = dataOffset + endFrame * bytesPerFrame;

    const newDataSize = Math.max(0, endByte - startByte);
    const out = new ArrayBuffer(44 + newDataSize);
    const view = new DataView(out);

    // Write header
    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + newDataSize, true);
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
    view.setUint32(40, newDataSize, true);

    // Copy data
    const src = new Uint8Array(buffer, startByte, newDataSize);
    const dst = new Uint8Array(out, 44, newDataSize);
    dst.set(src);

    return out;
  }

  private writeString(view: DataView, offset: number, string: string): void {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}
