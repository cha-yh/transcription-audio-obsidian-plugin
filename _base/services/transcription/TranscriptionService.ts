import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";

export class TranscriptionService {
  constructor() {}

  async transcribe(
    apiKey: string,
    prompt: string,
    audioBase64: string,
    mimeType: string,
    model: string,
    timeoutMs: number = 6 * 60 * 1000,
    onFileUploadStart?: () => void,
    onFileUploadComplete?: (elapsedMs: number) => void,
    onApiRequestStart?: () => void,
    onApiRequestComplete?: (elapsedMs: number) => void
  ): Promise<string> {
    if (!apiKey) {
      throw new Error("API Key is not provided.");
    }

    try {
      const ai = new GoogleGenAI({ apiKey });

      // convert base64 to Buffer and then to Blob
      const audioBuffer = Buffer.from(audioBase64, "base64");
      const audioBlob = new Blob([audioBuffer], {
        type: mimeType || "application/octet-stream",
      });

      // upload file to Google Gen AI
      const uploadStartAt = performance.now();
      onFileUploadStart?.();
      const uploadedFile = await Promise.race([
        (async () => {
          return await ai.files.upload({
            file: audioBlob,
            config: { mimeType: mimeType || "application/octet-stream" },
          });
        })(),
        new Promise<never>((_, reject) => {
          const id = setTimeout(() => {
            clearTimeout(id);
            reject(new Error(`File upload timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        }),
      ]);
      const uploadElapsedMs = Math.round(performance.now() - uploadStartAt);
      onFileUploadComplete?.(uploadElapsedMs);

      if (!uploadedFile.uri) {
        throw new Error("File upload failed: URI not returned");
      }

      if (!uploadedFile.mimeType) {
        throw new Error("File upload failed: MIME type not returned");
      }

      // API request start - measure API request time separately
      onApiRequestStart?.();
      const apiRequestStartAt = performance.now();

      // create content and receive response
      const text = await Promise.race([
        (async () => {
          const response = await ai.models.generateContent({
            model: model,
            contents: createUserContent([
              createPartFromUri(uploadedFile.uri!, uploadedFile.mimeType!),
              prompt,
            ]),
          });
          if (!response.text) {
            throw new Error("No text response from model");
          }
          return response.text;
        })(),
        new Promise<string>((_, reject) => {
          const id = setTimeout(() => {
            clearTimeout(id);
            reject(new Error(`Transcription timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        }),
      ]);

      const apiRequestElapsedMs = Math.round(
        performance.now() - apiRequestStartAt
      );
      onApiRequestComplete?.(apiRequestElapsedMs);

      return text;
    } catch (error) {
      console.error("Transcription failed:", error);
      throw error;
    }
  }
}
