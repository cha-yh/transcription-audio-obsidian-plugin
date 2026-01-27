import { AUDIO_FILE_REGEX } from "_base/constants/regex";

export interface ContextNotesResult {
  notes: string;
  wasTruncated: boolean;
}

export class ContextNotesService {
  /**
   * Extracts text content that appears after the audio file reference in a document.
   * This contextual information can be used to improve transcription accuracy by
   * providing speaker names, topics, terminology, etc.
   *
   * @param fullDocumentText - The complete document content
   * @param audioFilePath - The path of the audio file being transcribed
   * @param maxLength - Maximum character length for extracted notes
   * @returns The extracted notes with truncation info, or null if no notes found
   */
  extractContextNotes(
    fullDocumentText: string,
    audioFilePath: string,
    maxLength: number
  ): ContextNotesResult | null {
    // Find the position after the audio tag
    const tagEndPosition = this.findAudioTagEndPosition(
      fullDocumentText,
      audioFilePath
    );

    if (tagEndPosition === -1) {
      return null;
    }

    // Extract text from after the tag to end of document
    let notes = fullDocumentText.substring(tagEndPosition).trim();

    if (!notes || notes.length === 0) {
      return null;
    }

    // Truncate if necessary
    let wasTruncated = false;
    if (notes.length > maxLength) {
      notes = notes.substring(0, maxLength);
      wasTruncated = true;
    }

    return { notes, wasTruncated };
  }

  /**
   * Finds the end position of the audio tag in the document.
   * Supports both wiki-style [[path]] and markdown-style [](path) formats.
   */
  private findAudioTagEndPosition(
    text: string,
    audioFilePath: string
  ): number {
    // Escape special regex characters in the file path
    const escapedPath = audioFilePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Try wiki-style embed: ![[path]] or [[path]]
    const wikiPattern = new RegExp(`!?\\[\\[${escapedPath}\\]\\]`, "i");
    const wikiMatch = text.match(wikiPattern);
    if (wikiMatch && wikiMatch.index !== undefined) {
      return wikiMatch.index + wikiMatch[0].length;
    }

    // Try markdown-style: ![label](path) or [label](path)
    const mdPattern = new RegExp(`!?\\[[^\\]]*\\]\\(${escapedPath}\\)`, "i");
    const mdMatch = text.match(mdPattern);
    if (mdMatch && mdMatch.index !== undefined) {
      return mdMatch.index + mdMatch[0].length;
    }

    // Fallback: use the AUDIO_FILE_REGEX patterns to find any audio tag
    // and check if it matches the file path
    for (const regex of AUDIO_FILE_REGEX) {
      // Reset regex state
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        if (match[1] === audioFilePath) {
          return match.index + match[0].length;
        }
      }
    }

    return -1;
  }
}
