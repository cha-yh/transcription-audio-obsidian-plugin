import { App, MarkdownView, Notice, TFile } from "obsidian";

export class ObsidianInteractorService {
  constructor(private app: App) {}

  private _getActiveMarkdownView(): MarkdownView | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  // Insert text into the specified file (path) at the given position (line, ch)
  async appendTextToFile(
    path: string,
    line: number,
    ch: number,
    content: string
  ): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile))
        throw new Error(`Target file not found: ${path}`);
      const view = this._getActiveMarkdownView();
      if (view && view.file && view.file.path === path) {
        const editor = view.editor;
        editor.replaceRange(content, { line, ch });
      } else {
        // Read the file, insert at the position, then save the whole content
        const data = await this.app.vault.read(file);
        const lines = data.split("\n");
        const targetLine = lines[line] ?? "";
        const newLine =
          targetLine.slice(0, ch) + content + targetLine.slice(ch);
        lines[line] = newLine;
        await this.app.vault.modify(file, lines.join("\n"));
      }
    } catch (error) {
      console.error("Failed to write transcript to target file:", error);
      new Notice("Error writing transcript to target file.");
    }
  }
}
