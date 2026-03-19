import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  SecretComponent,
  Setting,
} from "obsidian";
import { TranscriptionController } from "./controllers/TranscriptionController";
import { getProgressViewType } from "./_base/constants/progress";
import { TranscriptionProgressView } from "./_base/ui/TranscriptionProgressView";
import { AudioPluginSettings, TranscriptionCategory } from "_base/types/setting";
import {
  DEFAULT_SETTINGS,
  MODELS,
  MODEL_MIGRATIONS,
  DEFAULT_BASIC_MODE_PROMPT,
  DEFAULT_TEMPLATE_MODE_PROMPT,
  DEFAULT_OUTPUT_TEMPLATE,
  DEFAULT_CATEGORIES,
  GENERAL_CATEGORY_ID,
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

    // Migrate categories if missing
    if (!this.settings.categories || this.settings.categories.length === 0) {
      this.settings.categories = DEFAULT_CATEGORIES;
    } else {
      // Migrate existing categories without enabled field
      for (const cat of this.settings.categories) {
        if (cat.enabled === undefined) {
          cat.enabled = cat.prompt.trim().length > 0;
        }
      }
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
      outputTemplate,
      this.settings.enableTranscribeThenSummarize,
      this.settings.enableCategoryClassification,
      this.settings.categories
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

  private generateCategoryId(): string {
    return "cat-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  private displayCategorySettings(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Categories" });
    containerEl.createEl("p", {
      text: "AI classifies each transcript into a category, then uses that category's prompt for summarization.",
      cls: "setting-item-description",
    });

    const categories = this.plugin.settings.categories;

    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const isGeneral = cat.id === GENERAL_CATEGORY_ID;
      const isDisabled = !cat.enabled;

      const descText = isGeneral
        ? "Default fallback category"
        : isDisabled
          ? "Prompt required to enable"
          : "";

      const setting = new Setting(containerEl).setName(cat.name);
      if (descText) setting.setDesc(descText);

      // Edit button — opens modal
      setting.addExtraButton((btn) => {
        btn.setIcon("pencil").setTooltip("Edit prompt").onClick(() => {
          new CategoryEditModal(
            this.app,
            cat,
            isGeneral,
            DEFAULT_CATEGORIES.find((d) => d.id === cat.id) || null,
            async () => {
              await this.plugin.saveSettings();
              this.display();
            }
          ).open();
        });
      });

      // Delete button (except General)
      if (!isGeneral) {
        setting.addExtraButton((btn) => {
          btn.setIcon("trash").setTooltip("Delete category").onClick(async () => {
            const confirmed = await this.confirmReset(
              `Delete category "${cat.name}"?`
            );
            if (!confirmed) return;
            this.plugin.settings.categories.splice(i, 1);
            await this.plugin.saveSettings();
            this.display();
          });
        });
      }
    }

    // Add category
    let newCategoryName = "";
    new Setting(containerEl)
      .setName("Add category")
      .setDesc("Enter a name and click Add to create a new category.")
      .addText((text) => {
        text.setPlaceholder("Category name").onChange((value) => {
          newCategoryName = value;
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Add").onClick(async () => {
          const trimmedName = newCategoryName.trim();
          if (!trimmedName) {
            new Notice("Please enter a category name.");
            return;
          }

          const exists = categories.some(
            (c) => c.name.toLowerCase() === trimmedName.toLowerCase()
          );
          if (exists) {
            new Notice(`Category "${trimmedName}" already exists.`);
            return;
          }

          const newCategory: TranscriptionCategory = {
            id: this.generateCategoryId(),
            name: trimmedName,
            prompt: "",
            enabled: false,
          };
          this.plugin.settings.categories.push(newCategory);
          await this.plugin.saveSettings();
          new Notice(`Category "${trimmedName}" added.`);
          this.display();
        });
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

    new Setting(containerEl)
      .setName("Transcribe then summarize")
      .setDesc(
        "When enabled, audio is first transcribed to raw text, saved to a temporary file, then summarized separately using your prompt. This produces more accurate results by separating transcription from summarization."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableTranscribeThenSummarize)
          .onChange(async (value) => {
            this.plugin.settings.enableTranscribeThenSummarize = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.enableTranscribeThenSummarize) {
      new Setting(containerEl)
        .setName("Category classification")
        .setDesc(
          "When enabled, AI classifies each transcript into a category and uses that category's prompt. When disabled, the General category prompt is used for all transcripts."
        )
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.enableCategoryClassification)
            .onChange(async (value) => {
              this.plugin.settings.enableCategoryClassification = value;
              await this.plugin.saveSettings();
              this.display();
            });
        });

      if (this.plugin.settings.enableCategoryClassification) {
        this.displayCategorySettings(containerEl);
      }
    }

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

class CategoryEditModal extends Modal {
  constructor(
    app: App,
    private cat: TranscriptionCategory,
    private isGeneral: boolean,
    private defaultCat: TranscriptionCategory | null,
    private onSave: () => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("transcription-audio-category-modal");

    contentEl.createEl("h3", { text: `Edit: ${this.cat.name}` });

    // Name
    new Setting(contentEl).setName("Name").addText((text) => {
      text.setValue(this.cat.name);
      if (this.isGeneral) text.setDisabled(true);
      text.onChange((value) => {
        this.cat.name = value.trim() || this.cat.name;
      });
    });

    // Prompt label
    const promptSetting = new Setting(contentEl)
      .setName("Prompt")
      .setDesc("Enter a prompt to enable this category.");
    promptSetting.settingEl.classList.add(
      "transcription-audio-modal-prompt-label"
    );

    // Prompt textarea (full width, below label)
    const textArea = contentEl.createEl("textarea", {
      cls: "transcription-audio-setting-text-area transcription-audio-modal-textarea",
    });
    textArea.value = this.cat.prompt;
    textArea.placeholder = "Enter a prompt to enable this category...";
    textArea.addEventListener("input", () => {
      this.cat.prompt = textArea.value;
      this.cat.enabled = textArea.value.trim().length > 0;
    });

    // Buttons row
    const btnRow = contentEl.createDiv({
      cls: "transcription-audio-modal-buttons",
    });

    if (this.defaultCat) {
      const resetBtn = btnRow.createEl("button", {
        text: "Reset prompt to default",
      });
      resetBtn.addEventListener("click", async () => {
        const confirmed = window.confirm(
          `Reset "${this.cat.name}" prompt to default?`
        );
        if (!confirmed) return;
        this.cat.prompt = this.defaultCat!.prompt;
        this.cat.enabled = true;
        textArea.value = this.cat.prompt;
        await this.onSave();
        new Notice(`"${this.cat.name}" prompt reset to default.`);
      });
    }

    const saveBtn = btnRow.createEl("button", {
      text: "Save",
      cls: "mod-cta",
    });
    saveBtn.addEventListener("click", () => {
      void this.onSave();
      this.close();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
