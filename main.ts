import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
} from "obsidian";
import { TranscriptionController } from "./controllers/TranscriptionController";
import { VIEW_TYPE_PROGRESS } from "./_base/constants/progress";
import { TranscriptionProgressView } from "./_base/ui/TranscriptionProgressView";
import { AudioPluginSettings } from "_base/types/setting";
import { DEFAULT_SETTINGS, MODELS } from "_base/constants/setting";

const SECRET_STORAGE_VERSION_MESSAGE =
  "SecretStorage requires Obsidian 1.11.4+. Please update Obsidian to use this field.";

function canUseSecretStorage(app: App): boolean {
  return typeof app.secretStorage?.getSecret === "function";
}

function canUseSecretComponent(app: App): boolean {
  return typeof SecretComponent === "function" && canUseSecretStorage(app);
}

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
    const secretApiKey =
      this.settings.secretApiKeyName && canUseSecretStorage(this.app)
        ? this.app.secretStorage?.getSecret(this.settings.secretApiKeyName) ??
          null
        : null;
    const apiKey = secretApiKey || this.settings.apiKey;

    if (!canUseSecretStorage(this.app) && this.settings.secretApiKeyName) {
      new Notice(
        `${SECRET_STORAGE_VERSION_MESSAGE} Falling back to deprecated API key.`
      );
    }

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

    if (canUseSecretComponent(this.app)) {
      const secretSetting = new Setting(containerEl)
        .setName("API key (SecretStorage, recommended)")
        .setDesc("Select a secret key name from Obsidian SecretStorage");

      new SecretComponent(this.app, secretSetting.controlEl)
        .setValue(this.plugin.settings.secretApiKeyName)
        .onChange(async (value) => {
          this.plugin.settings.secretApiKeyName = value;
          await this.plugin.saveSettings();
        });
    } else {
      new Setting(containerEl)
        .setName("API key (SecretStorage, recommended)")
        .setDesc(SECRET_STORAGE_VERSION_MESSAGE)
        .addText((text) => {
          text
            .setPlaceholder("Update Obsidian to enable SecretStorage")
            .setValue(this.plugin.settings.secretApiKeyName)
            .setDisabled(true);
        });
    }

    new Setting(containerEl)
      .setName("API key (deprecated, not recommended)")
      .setDesc("Legacy plain-text API key. Used only as fallback.")
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
