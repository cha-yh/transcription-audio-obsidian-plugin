import { GoogleGenerativeAI } from "@google/generative-ai";

export class TranscriptionService {
  constructor() {}

  async transcribe(
    apiKey: string,
    prompt: string,
    audioBase64: string,
    mimeType: string,
    timeoutMs: number = 6 * 60 * 1000
  ): Promise<string> {
    if (!apiKey) {
      throw new Error("API Key is not provided.");
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

      const audioPart = {
        inlineData: {
          data: audioBase64,
          mimeType: mimeType || "application/octet-stream",
        },
      } as const;

      const text = await Promise.race([
        (async () => {
          const result = await model.generateContent([prompt, audioPart]);
          const response = await result.response;
          return response.text();
        })(),
        new Promise<string>((_, reject) => {
          const id = setTimeout(() => {
            clearTimeout(id);
            reject(new Error(`Transcription timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        }),
      ]);
      return text;
    } catch (error) {
      console.error("Transcription failed:", error);
      throw error;
    }
  }
}
