import { App, TAbstractFile } from "obsidian";

export class ObsidianFileService {
  constructor(private app: App) {}

  findFilePath(text: string, regex: RegExp[]) {
    let filename = "";
    let result: RegExpExecArray | null;
    for (const reg of regex) {
      while ((result = reg.exec(text)) !== null) {
        filename = decodeURI(result[0]).trim();
      }
    }
    if (filename === "") throw new Error("No file found in the text.");
    const fullPath = filename;
    const fileExists =
      this.app.vault.getAbstractFileByPath(fullPath) instanceof TAbstractFile;
    if (fileExists) return fullPath;
    const allFiles = this.app.vault.getFiles();
    const foundFile = allFiles.find(
      (file) => file.name === filename.split("/").pop()
    );
    if (foundFile) return foundFile.path;
    throw new Error("File not found");
  }
}
