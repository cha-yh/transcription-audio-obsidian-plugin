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
import {
  AudioPluginSettings,
  TranscriptionCategory,
  TranscriptionInputMode,
} from "_base/types/setting";
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
  "Secure API key storage requires Obsidian 1.11.4+. Please update Obsidian to use this field.";

const MODE_OPTIONS: Record<string, string> = {
  basic: "Prompt only mode",
  transcription: "Transcription mode",
  "transcription-only": "Transcription only mode",
};

const MODE_DESCRIPTIONS: Record<TranscriptionInputMode, string> = {
  basic: "Sends the audio directly with the prompt.",
  transcription:
    "Creates a transcript from the audio, then runs the prompt against that transcript. This uses additional tokens for transcript generation.",
  "transcription-only": "Creates only a transcript from the audio.",
};

type LegacyTranscriptionInputMode = TranscriptionInputMode | "template";

type SavedAudioPluginSettings = Omit<
  Partial<AudioPluginSettings>,
  "mode"
> & {
  mode?: LegacyTranscriptionInputMode;
  apiKey?: string;
  enableTranscribeThenSummarize?: boolean;
  transcriptionOnly?: boolean;
};

function canUseSecretStorage(app: App): boolean {
  return typeof app.secretStorage?.getSecret === "function";
}

function canUseSecretComponent(app: App): boolean {
  return typeof SecretComponent === "function" && canUseSecretStorage(app);
}

function cloneCategories(
  categories: TranscriptionCategory[]
): TranscriptionCategory[] {
  return categories.map((category) => ({ ...category }));
}

function isTranscriptionInputMode(
  mode: LegacyTranscriptionInputMode | undefined
): mode is TranscriptionInputMode {
  return (
    mode === "basic" ||
    mode === "transcription" ||
    mode === "transcription-only"
  );
}

export default class TranscriptionAudioPlugin extends Plugin {
  settings: AudioPluginSettings;

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

  onunload(): void {
    // Deliberately no detachLeavesOfType here: Obsidian tears the view down
    // itself, and detaching during unload both double-removes DOM nodes and
    // discards the user's sidebar placement.
    this.transcriptionController.dispose();
  }

  async loadSettings() {
    const savedSettings = (await this.loadData()) as
      | SavedAudioPluginSettings
      | null;
    const {
      apiKey: deprecatedApiKey,
      mode: savedMode,
      enableTranscribeThenSummarize: deprecatedTranscribeThenSummarize,
      transcriptionOnly: deprecatedTranscriptionOnly,
      ...settingsWithoutDeprecatedFields
    } = savedSettings ?? {};
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      settingsWithoutDeprecatedFields
    );

    const savedCategories: TranscriptionCategory[] =
      savedSettings && Array.isArray(savedSettings.categories)
        ? savedSettings.categories
        : [];
    this.settings.categories = cloneCategories(
      savedCategories.length > 0 ? savedCategories : DEFAULT_CATEGORIES
    );
    let shouldSaveSettings =
      deprecatedApiKey !== undefined ||
      deprecatedTranscribeThenSummarize !== undefined ||
      deprecatedTranscriptionOnly !== undefined ||
      savedMode === "template";

    if (savedMode === "template") {
      this.settings.enableTemplatePrompt = true;
    }

    if (deprecatedTranscribeThenSummarize || deprecatedTranscriptionOnly) {
      this.settings.mode = deprecatedTranscriptionOnly
        ? "transcription-only"
        : "transcription";
    } else if (savedMode === "template") {
      this.settings.mode = "basic";
    } else if (isTranscriptionInputMode(savedMode)) {
      this.settings.mode = savedMode;
    } else {
      this.settings.mode = DEFAULT_SETTINGS.mode;
    }

    const previousModel = this.settings.model;
    const migratedModel = MODEL_MIGRATIONS[previousModel] || previousModel;
    if (MODELS.includes(migratedModel)) {
      this.settings.model = migratedModel;
    } else {
      this.settings.model = DEFAULT_SETTINGS.model;
    }

    // Migrate existing categories without enabled field
    for (const cat of this.settings.categories) {
      if (cat.enabled === undefined) {
        cat.enabled = (cat.prompt || "").trim().length > 0;
        shouldSaveSettings = true;
      }
    }

    if (this.settings.model !== previousModel) {
      shouldSaveSettings = true;
    }

    if (shouldSaveSettings) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async commandGenerateTranscript(editor: Editor) {
    const apiKey =
      this.settings.secretApiKeyName && canUseSecretStorage(this.app)
        ? this.app.secretStorage?.getSecret(this.settings.secretApiKeyName) ??
          undefined
        : undefined;

    if (!canUseSecretStorage(this.app) && this.settings.secretApiKeyName) {
      new Notice(SECRET_STORAGE_VERSION_MESSAGE);
    }

    const selectedMode = this.settings.mode || "basic";
    const usePromptSettings =
      selectedMode === "basic" ||
      (selectedMode === "transcription" &&
        !this.settings.enableCategoryClassification);
    const useTemplatePrompt =
      usePromptSettings && this.settings.enableTemplatePrompt;
    const prompt = useTemplatePrompt
      ? this.settings.templatePrompt || DEFAULT_TEMPLATE_MODE_PROMPT
      : this.settings.prompt;
    const outputTemplate = useTemplatePrompt
      ? this.settings.outputTemplate || DEFAULT_OUTPUT_TEMPLATE
      : "";
    const enableTranscribeThenSummarize =
      selectedMode === "transcription" || selectedMode === "transcription-only";
    const transcriptionOnly = selectedMode === "transcription-only";

    await this.transcriptionController.run(
      editor,
      apiKey,
      prompt,
      this.settings.model,
      outputTemplate,
      enableTranscribeThenSummarize,
      transcriptionOnly,
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
    return new Promise<boolean>((resolve) => {
      new ConfirmModal(this.app, message, "Reset", resolve).open();
    });
  }

  private addInlineResetButton(
    textAreaEl: HTMLTextAreaElement,
    label: string,
    onReset: () => Promise<void>
  ): void {
    const controlEl = textAreaEl.closest(
      ".setting-item-control"
    ) as HTMLElement | null;
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

  private displayDescriptionBlock(
    containerEl: HTMLElement,
    title: string,
    description: string
  ): void {
    const titleEl = containerEl.createEl("h3", {
      text: title,
      cls: "transcription-audio-mode-description-title",
    });
    titleEl.style.setProperty("padding-left", "0", "important");
    titleEl.style.setProperty("padding-inline-start", "0", "important");
    titleEl.style.setProperty("margin-bottom", "0", "important");
    titleEl.style.setProperty("margin-block-end", "0", "important");

    const descriptionEl = containerEl.createEl("p", {
      text: description,
      cls: "setting-item-description transcription-audio-mode-description",
    });
    descriptionEl.style.setProperty("margin-top", "4px", "important");
    descriptionEl.style.setProperty("margin-block-start", "4px", "important");
  }

  private generateCategoryId(): string {
    return (
      "cat-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    );
  }

  private displayCategorySettings(containerEl: HTMLElement): void {
    this.displayDescriptionBlock(
      containerEl,
      "Categories",
      "AI classifies each transcript into a category, then uses that category's prompt for summarization."
    );

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
        btn
          .setIcon("pencil")
          .setTooltip("Edit prompt")
          .onClick(() => {
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
          btn
            .setIcon("trash")
            .setTooltip("Delete category")
            .onClick(async () => {
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

  private displayPromptOnlySettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Template prompt")
      .setDesc(
        "Use a dedicated prompt and markdown template for the final output."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableTemplatePrompt)
          .onChange(async (value) => {
            this.plugin.settings.enableTemplatePrompt = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.enableTemplatePrompt) {
      new Setting(containerEl)
        .setName("Template prompt instructions")
        .setDesc(
          "Prompt used with the output template for deterministic note generation guidance."
        )
        .addTextArea((text) => {
          if (text.inputEl) {
            text.inputEl.classList.add("transcription-audio-setting-text-area");
          }
          text
            .setPlaceholder(DEFAULT_SETTINGS.templatePrompt)
            .setValue(
              this.plugin.settings.templatePrompt ||
                DEFAULT_TEMPLATE_MODE_PROMPT
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
                "Reset the template prompt to its default value?"
              );
              if (!confirmed) {
                return;
              }

              this.plugin.settings.templatePrompt =
                DEFAULT_TEMPLATE_MODE_PROMPT;
              await this.plugin.saveSettings();
              new Notice("Template prompt reset to default.");
              this.display();
            }
          );
        });

      new Setting(containerEl)
        .setName("Output template")
        .setDesc(
          "Final output is formatted to this markdown template for consistency."
        )
        .addTextArea((text) => {
          if (text.inputEl) {
            text.inputEl.classList.add("transcription-audio-setting-text-area");
          }
          text
            .setPlaceholder(DEFAULT_OUTPUT_TEMPLATE)
            .setValue(
              this.plugin.settings.outputTemplate || DEFAULT_OUTPUT_TEMPLATE
            )
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
    } else {
      new Setting(containerEl)
        .setName("Prompt")
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
                "Reset the Prompt only mode prompt to its default value?"
              );
              if (!confirmed) {
                return;
              }

              this.plugin.settings.prompt = DEFAULT_BASIC_MODE_PROMPT;
              await this.plugin.saveSettings();
              new Notice("Prompt reset to default.");
              this.display();
            }
          );
        });
    }
  }

  display(): void {
    let { containerEl } = this;
    containerEl.empty();

    if (canUseSecretComponent(this.app)) {
      const secretSetting = new Setting(containerEl)
        .setName("API key")
        .setDesc("Select the API key to use.");

      new SecretComponent(this.app, secretSetting.controlEl)
        .setValue(this.plugin.settings.secretApiKeyName)
        .onChange(async (value) => {
          this.plugin.settings.secretApiKeyName = value;
          await this.plugin.saveSettings();
        });
    } else {
      new Setting(containerEl)
        .setName("API key")
        .setDesc(SECRET_STORAGE_VERSION_MESSAGE)
        .addText((text) => {
          text
            .setPlaceholder("Update Obsidian to enable API key storage")
            .setValue(this.plugin.settings.secretApiKeyName)
            .setDisabled(true);
        });
    }

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

    const selectedMode = this.plugin.settings.mode || "basic";

    new Setting(containerEl)
      .setName("Transcription mode")
      .addDropdown((dropdown) => {
        dropdown.addOptions(MODE_OPTIONS);
        dropdown.setValue(selectedMode);
        dropdown.onChange(async (value) => {
          this.plugin.settings.mode =
            value === "transcription" || value === "transcription-only"
              ? value
              : "basic";
          await this.plugin.saveSettings();
          this.display();
        });
      });

    this.displayDescriptionBlock(
      containerEl,
      `Transcription mode: ${MODE_OPTIONS[selectedMode]}`,
      MODE_DESCRIPTIONS[selectedMode]
    );

    if (this.plugin.settings.mode === "transcription-only") {
      // Transcription-only mode: no prompt or template needed
    } else if ((this.plugin.settings.mode || "basic") === "basic") {
      this.displayPromptOnlySettings(containerEl);
    } else {
      new Setting(containerEl)
        .setName("Category classification")
        .setDesc(
          "When enabled, AI classifies each transcript into a category and uses that category's prompt. When disabled, prompt settings below are used for all transcripts."
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
      } else {
        this.displayPromptOnlySettings(containerEl);
      }
    }
  }
}

/**
 * Yes/no prompt built on Obsidian's Modal.
 *
 * window.confirm is not answerable in every WebView Obsidian runs in — where it
 * is ignored it returns false, which reads as "the user declined" and silently
 * does nothing.
 */
class ConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private message: string,
    private confirmLabel: string,
    private onDecision: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: this.message });

    const buttons = contentEl.createDiv({
      cls: "transcription-audio-modal-buttons",
    });

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.finish(false));

    const confirmBtn = buttons.createEl("button", { text: this.confirmLabel });
    confirmBtn.addClass("mod-warning");
    confirmBtn.addEventListener("click", () => this.finish(true));
  }

  onClose() {
    this.contentEl.empty();
    // Dismissing the modal any other way counts as declining.
    this.finish(false);
  }

  private finish(confirmed: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.onDecision(confirmed);
    this.close();
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
        const confirmed = await new Promise<boolean>((resolve) => {
          new ConfirmModal(
            this.app,
            `Reset "${this.cat.name}" prompt to default?`,
            "Reset",
            resolve
          ).open();
        });
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
