import {
  App,
  Editor,
  MarkdownView,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import { TranscriptionController } from "./controllers/TranscriptionController";
import { VIEW_TYPE_PROGRESS } from "./_base/constants/progress";
import { TranscriptionProgressView } from "./_base/ui/TranscriptionProgressView";
import { AudioPluginSettings } from "_base/types/setting";
import { DEFAULT_SETTINGS, MODELS } from "_base/constants/setting";

export default class TranscriptionAudioPlugin extends Plugin {
  settings: AudioPluginSettings;
  writing: boolean = false;

  private transcriptionController: TranscriptionController;

  async onload() {
    await this.loadSettings();

    this.transcriptionController = new TranscriptionController(this.app);

    this.registerView(
      VIEW_TYPE_PROGRESS,
      (leaf) => new TranscriptionProgressView(leaf)
    );

    this.addCommand({
      id: "transcription-audio",
      name: "Transcribe audio",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.commandGenerateTranscript(editor);
      },
    });

    this.addSettingTab(new TranscriptionSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async commandGenerateTranscript(editor: Editor) {
    const apiKey = this.settings.apiKey;
    await this.transcriptionController.run(
      editor,
      apiKey,
      this.settings.prompt,
      this.settings.model
    );
  }
}

class TranscriptionSettingTab extends PluginSettingTab {
  plugin: TranscriptionAudioPlugin;

  constructor(app: App, plugin: TranscriptionAudioPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your Google AI API key")
      .addText((text) => {
        // mask input
        text.inputEl.type = "password";
        text
          .setPlaceholder("Enter your API key")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Select the model to use for note-generation")
      .addDropdown((dropdown) => {
        dropdown.addOptions(
          MODELS.reduce((models: { [key: string]: string }, model) => {
            models[model] = model;
            return models;
          }, {})
        );
        dropdown.setValue(this.plugin.settings.model);
        dropdown.onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Custom transcription-to-notes prompt")
      .setDesc(
        "Prompt that will be sent to the AI right before adding your transcribed audio"
      )
      .addTextArea((text) => {
        if (text.inputEl) {
          text.inputEl.classList.add("transcription-audio-setting-text-area");
        }
        text
          .setPlaceholder(DEFAULT_SETTINGS.prompt)
          .setValue(this.plugin.settings.prompt)
          .onChange(async (value) => {
            this.plugin.settings.prompt = value;
            await this.plugin.saveSettings();
          });
      });
  }
}
