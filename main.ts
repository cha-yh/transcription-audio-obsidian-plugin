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
  MAX_HISTORY_LIMIT,
  MIN_HISTORY_LIMIT,
  SESSION_HISTORY_FILE,
} from "_base/constants/sessionHistory";
import {
  clampHistoryLimit,
  resolveHistoryLimit,
} from "_base/utils/sessionSnapshot";
import {
  ProgressHistoryStore,
  type SessionHistoryPort,
} from "_base/services/session/ProgressHistoryStore";
import {
  DEFAULT_SETTINGS,
  MODELS,
  DEFAULT_BASIC_MODE_PROMPT,
  DEFAULT_CATEGORIES,
} from "_base/constants/setting";
import { getCompatibleSettings } from "_base/utils/settingsCompatibility";

const SECRET_STORAGE_VERSION_MESSAGE =
  "Secure API key storage requires Obsidian 1.11.4+. Please update Obsidian to use this field.";

function canUseSecretStorage(app: App): boolean {
  return typeof app.secretStorage?.getSecret === "function";
}

function canUseSecretComponent(app: App): boolean {
  return typeof SecretComponent === "function" && canUseSecretStorage(app);
}

export default class TranscriptionAudioPlugin extends Plugin {
  settings: AudioPluginSettings;

  private transcriptionController: TranscriptionController;
  private progressViewType: string;
  private historyStore: ProgressHistoryStore;

  async onload() {
    await this.loadSettings();

    this.progressViewType = getProgressViewType(this.manifest.id);

    this.historyStore = new ProgressHistoryStore(this.createHistoryPort(), {
      enabled: this.settings.enableSessionHistory,
      limit: resolveHistoryLimit(this.settings),
    });
    // Read once per load, before any view can open: this is also where a run
    // that was still going when the plugin last unloaded gets marked as
    // interrupted, which reopening the sidebar must not redo.
    await this.historyStore.hydrate();

    this.transcriptionController = new TranscriptionController(
      this.app,
      this.progressViewType
    );

    this.registerView(
      this.progressViewType,
      (leaf) =>
        new TranscriptionProgressView(
          leaf,
          this.progressViewType,
          this.historyStore,
          () => this.settings
        )
    );

    this.addCommand({
      id: "transcription-audio",
      name: "Transcribe audio",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.commandGenerateTranscript(editor);
      },
    });

    this.addCommand({
      id: "open-progress-panel",
      name: "Open progress panel",
      callback: () => {
        // The view restores whatever the store holds as it opens, so this is
        // also how a user gets their saved run history back on screen.
        void this.transcriptionController.openProgressView();
      },
    });

    this.addSettingTab(new TranscriptionSettingTab(this.app, this));
  }

  onunload(): void {
    // Deliberately no detachLeavesOfType here: Obsidian tears the view down
    // itself, and detaching during unload both double-removes DOM nodes and
    // discards the user's sidebar placement.
    this.transcriptionController.dispose();
    // Best-effort: Obsidian does not await onunload, which is why finishing a
    // run writes immediately rather than relying on this.
    this.historyStore.dispose();
  }

  /**
   * File access for the history store, kept out of the store itself so its
   * tests need no Obsidian mock.
   */
  private createHistoryPort(): SessionHistoryPort {
    const adapter = this.app.vault.adapter;
    const dir =
      this.manifest.dir ??
      `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    const path = `${dir}/${SESSION_HISTORY_FILE}`;

    return {
      read: async () => ((await adapter.exists(path)) ? adapter.read(path) : null),
      write: (data) => adapter.write(path, data),
      backup: async (label) => {
        const backupPath = `${dir}/${SESSION_HISTORY_FILE.replace(
          /\.json$/,
          ""
        )}.${label}.bak.json`;
        if (await adapter.exists(backupPath)) {
          await adapter.remove(backupPath);
        }
        await adapter.rename(path, backupPath);
      },
    };
  }

  /** Re-applies the history settings to the store and any open panel. */
  async applyHistorySettings(): Promise<void> {
    const wasEnabled = this.historyStore.isEnabled();
    this.historyStore.setOptions({
      enabled: this.settings.enableSessionHistory,
      limit: resolveHistoryLimit(this.settings),
    });

    // Switching history back on: the file was left untouched while it was
    // off, so read it back before anything writes over it.
    const restored = !wasEnabled && this.settings.enableSessionHistory;
    if (restored) {
      await this.historyStore.hydrate();
    }

    for (const leaf of this.app.workspace.getLeavesOfType(
      this.progressViewType
    )) {
      const view = leaf.view;
      if (!(view instanceof TranscriptionProgressView)) continue;
      if (restored) {
        view.mergeRestored(this.historyStore.list());
      }
      view.applyHistorySettings();
    }
  }

  async loadSettings() {
    const { settings, shouldSave } = getCompatibleSettings(await this.loadData());
    this.settings = settings;

    if (shouldSave) {
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

    await this.transcriptionController.run(editor, {
      apiKey,
      prompt: this.settings.prompt || DEFAULT_BASIC_MODE_PROMPT,
      model: this.settings.model,
      summarizeTranscript: this.settings.summarizeTranscript,
      enableCategoryClassification: this.settings.enableCategoryClassification,
      categories: this.settings.categories,
    });
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
      const isDisabled = !cat.enabled;

      const descText = isDisabled ? "Prompt required to enable" : "";

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
              DEFAULT_CATEGORIES.find((d) => d.id === cat.id) || null,
              async () => {
                await this.plugin.saveSettings();
                this.display();
              }
            ).open();
          });
      });

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

  private displayHistorySettings(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    // The summarization settings above end in the category list, which has a
    // heading of its own; without a break of its own this section reads as a
    // continuation of it rather than as something independent of summarizing.
    containerEl.createEl("hr", {
      cls: "transcription-audio-setting-divider",
    });
    this.displayDescriptionBlock(
      containerEl,
      "Run history",
      "The progress panel's record of past runs, stored alongside the plugin's settings."
    );

    new Setting(containerEl)
      .setName("Keep run history")
      .setDesc(
        "Keeps records across plugin reloads and updates. Turning this off stops new records being saved; records already on disk are left alone."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(settings.enableSessionHistory)
          .onChange(async (value) => {
            settings.enableSessionHistory = value;
            await this.plugin.saveSettings();
            await this.plugin.applyHistorySettings();
            this.display();
          });
      });

    if (!settings.enableSessionHistory) {
      return;
    }

    new Setting(containerEl)
      .setName("Auto-remove old records")
      .setDesc("Drops the oldest records once the panel passes the limit.")
      .addToggle((toggle) => {
        toggle
          .setValue(settings.autoPruneSessionHistory)
          .onChange(async (value) => {
            settings.autoPruneSessionHistory = value;
            await this.plugin.saveSettings();
            await this.plugin.applyHistorySettings();
            this.display();
          });
      });

    if (!settings.autoPruneSessionHistory) {
      return;
    }

    new Setting(containerEl)
      .setName("Records to keep")
      .setDesc(
        `How many runs stay in the panel. ${MIN_HISTORY_LIMIT}-${MAX_HISTORY_LIMIT}. A run in progress is always kept.`
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_HISTORY_LIMIT);
        text.inputEl.max = String(MAX_HISTORY_LIMIT);
        text.setValue(String(settings.sessionHistoryLimit));

        // Committed when the field is left, not on every keystroke. Saving
        // mid-typing applies the intermediate value: typing "150" would pass
        // through 1 and prune the panel down to a single record before the
        // rest of the number arrives, and that deletion is not undone by the
        // later keystrokes.
        const commit = async () => {
          const limit = clampHistoryLimit(text.inputEl.value);
          const next = limit ?? settings.sessionHistoryLimit;
          text.setValue(String(next));
          if (next === settings.sessionHistoryLimit) return;
          settings.sessionHistoryLimit = next;
          await this.plugin.saveSettings();
          await this.plugin.applyHistorySettings();
        };

        text.inputEl.addEventListener("blur", () => void commit());
        text.inputEl.addEventListener("change", () => void commit());
      });
  }
  /**
   * Everything that only matters once a summary is produced. Kept apart
   * from display() so that a setting unrelated to summarization cannot be
   * hidden by this condition, which is what happened to run history.
   */
  private displaySummarySettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Default prompt")
      .setDesc("Used for summarization and whenever no category matches.")
      .addTextArea((text) => {
        text.inputEl.classList.add("transcription-audio-setting-text-area");
        text
          .setPlaceholder(DEFAULT_SETTINGS.prompt)
          .setValue(this.plugin.settings.prompt)
          .onChange(async (value) => {
            this.plugin.settings.prompt = value;
            await this.plugin.saveSettings();
          });

        this.addInlineResetButton(text.inputEl, "Reset to default", async () => {
          const confirmed = await this.confirmReset(
            "Reset the default prompt to its default value?"
          );
          if (!confirmed) return;
          this.plugin.settings.prompt = DEFAULT_BASIC_MODE_PROMPT;
          await this.plugin.saveSettings();
          new Notice("Prompt reset to default.");
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Category classification")
      .setDesc(
        "Classify each transcript and use the matching category prompt. The default prompt is used when no category matches."
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

    new Setting(containerEl)
      .setName("Summarize transcript")
      .setDesc("A transcript is always created. Turn this off to save only the transcript.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.summarizeTranscript)
          .onChange(async (value) => {
            this.plugin.settings.summarizeTranscript = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.summarizeTranscript) {
      this.displaySummarySettings(containerEl);
    }

    this.displayHistorySettings(containerEl);
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
