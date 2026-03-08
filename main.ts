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
import { getProgressViewType } from "./_base/constants/progress";
import { TranscriptionProgressView } from "./_base/ui/TranscriptionProgressView";
import { AudioPluginSettings } from "_base/types/setting";
import {
  DEFAULT_SETTINGS,
  MODELS,
  MODEL_MIGRATIONS,
  DEFAULT_BASIC_MODE_PROMPT,
  DEFAULT_TEMPLATE_MODE_PROMPT,
  DEFAULT_OUTPUT_TEMPLATE,
} from "_base/constants/setting";

const SECRET_STORAGE_VERSION_MESSAGE =
  "SecretStorage requires Obsidian 1.11.4+. Please update Obsidian to use this field.";

const MODE_OPTIONS: Record<string, string> = {
  basic: "Basic mode (prompt only)",
  template: "Template mode (prompt + template)",
};

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
  private progressViewType: string;

  async onload() {
    await this.loadSettings();

    this.progressViewType = getProgressViewType(this.manifest.id);

    this.transcriptionController = new TranscriptionController(
      this.app,
      this.progressViewType
    );

    this.registerView(
      this.progressViewType,
      (leaf) => new TranscriptionProgressView(leaf, this.progressViewType)
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

    const previousModel = this.settings.model;
    const migratedModel = MODEL_MIGRATIONS[previousModel] || previousModel;
    if (MODELS.includes(migratedModel)) {
      this.settings.model = migratedModel;
    } else {
      this.settings.model = DEFAULT_SETTINGS.model;
    }

    if (this.settings.model !== previousModel) {
      await this.saveSettings();
    }
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

    const selectedMode = this.settings.mode || "basic";
    const prompt =
      selectedMode === "template"
        ? this.settings.templatePrompt || DEFAULT_TEMPLATE_MODE_PROMPT
        : this.settings.prompt;
    const outputTemplate =
      selectedMode === "template"
        ? this.settings.outputTemplate || DEFAULT_OUTPUT_TEMPLATE
        : "";

    await this.transcriptionController.run(
      editor,
      apiKey,
      prompt,
      this.settings.model,
      outputTemplate
    );
  }
}

class TranscriptionSettingTab extends PluginSettingTab {
  plugin: TranscriptionAudioPlugin;

  constructor(app: App, plugin: TranscriptionAudioPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private async confirmReset(message: string): Promise<boolean> {
    return window.confirm(message);
  }

  private addInlineResetButton(
    textAreaEl: HTMLTextAreaElement,
    label: string,
    onReset: () => Promise<void>
  ): void {
    const controlEl = textAreaEl.closest(".setting-item-control") as
      | HTMLElement
      | null;
    const parentEl = textAreaEl.parentElement;
    if (!controlEl || !parentEl) {
      return;
    }

    controlEl.classList.add("transcription-audio-setting-with-reset");

    const actionRowEl = parentEl.createDiv({
      cls: "transcription-audio-setting-action-row",
    });
    const resetButtonEl = actionRowEl.createEl("button", {
      text: label,
      cls: "transcription-audio-setting-text-button",
    });
    resetButtonEl.type = "button";
    resetButtonEl.addEventListener("click", () => {
      void onReset();
    });
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
      .setName("Transcription mode")
      .setDesc("Choose how output instructions are provided.")
      .addDropdown((dropdown) => {
        dropdown.addOptions(MODE_OPTIONS);
        dropdown.setValue(this.plugin.settings.mode || "basic");
        dropdown.onChange(async (value) => {
          this.plugin.settings.mode = value === "template" ? "template" : "basic";
          await this.plugin.saveSettings();
          this.display();
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

    if ((this.plugin.settings.mode || "basic") === "basic") {
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

          this.addInlineResetButton(
            text.inputEl,
            "Reset to default",
            async () => {
              const confirmed = await this.confirmReset(
                "Reset the basic mode prompt to its default value?"
              );
              if (!confirmed) {
                return;
              }

              this.plugin.settings.prompt = DEFAULT_BASIC_MODE_PROMPT;
              await this.plugin.saveSettings();
              new Notice("Basic mode prompt reset to default.");
              this.display();
            }
          );
        });
    } else {
      new Setting(containerEl)
        .setName("Template mode prompt")
        .setDesc(
          "Prompt used in template mode for deterministic note generation guidance."
        )
        .addTextArea((text) => {
          if (text.inputEl) {
            text.inputEl.classList.add("transcription-audio-setting-text-area");
          }
          text
            .setPlaceholder(DEFAULT_SETTINGS.templatePrompt)
            .setValue(
              this.plugin.settings.templatePrompt || DEFAULT_TEMPLATE_MODE_PROMPT
            )
            .onChange(async (value) => {
              this.plugin.settings.templatePrompt = value;
              await this.plugin.saveSettings();
            });

          this.addInlineResetButton(
            text.inputEl,
            "Reset to default",
            async () => {
              const confirmed = await this.confirmReset(
                "Reset the template mode prompt to its default value?"
              );
              if (!confirmed) {
                return;
              }

              this.plugin.settings.templatePrompt = DEFAULT_TEMPLATE_MODE_PROMPT;
              await this.plugin.saveSettings();
              new Notice("Template mode prompt reset to default.");
              this.display();
            }
          );
        });

      new Setting(containerEl)
        .setName("Output template")
        .setDesc(
          "Template mode only. Final output is formatted to this markdown template for consistency."
        )
        .addTextArea((text) => {
          if (text.inputEl) {
            text.inputEl.classList.add("transcription-audio-setting-text-area");
          }
          text
            .setPlaceholder(DEFAULT_OUTPUT_TEMPLATE)
            .setValue(this.plugin.settings.outputTemplate || DEFAULT_OUTPUT_TEMPLATE)
            .onChange(async (value) => {
              this.plugin.settings.outputTemplate = value;
              await this.plugin.saveSettings();
            });

          this.addInlineResetButton(
            text.inputEl,
            "Reset to default",
            async () => {
              const confirmed = await this.confirmReset(
                "Reset the output template to its default value?"
              );
              if (!confirmed) {
                return;
              }

              this.plugin.settings.outputTemplate = DEFAULT_OUTPUT_TEMPLATE;
              await this.plugin.saveSettings();
              new Notice("Output template reset to default.");
              this.display();
            }
          );
        });
    }
  }
}
