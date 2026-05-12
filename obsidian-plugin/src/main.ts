import { Plugin, Notice, PluginSettingTab, App, Setting, MarkdownView, Editor, TFile } from 'obsidian';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import { ViewPlugin, Decoration, WidgetType, type DecorationSet } from '@codemirror/view';
import type { AnnotationType } from '@codemirror/state';

interface LiveSyncSettings {
    serverUrl: string;
    token: string;
    userName: string;
    userColor: string;
    enableCursors: boolean;
}

const DEFAULT_SETTINGS: LiveSyncSettings = {
    serverUrl: '',
    token: '',
    userName: 'Anonymous',
    userColor: '#007bff',
    enableCursors: true,
};

// Generate a random color for the user
function generateRandomColor(): string {
    const colors = ['#e63946', '#f4a261', '#2a9d8f', '#264653', '#e76f51', '#f08a5d', '#b83b5e', '#6a2c70'];
    return colors[Math.floor(Math.random() * colors.length)];
}

export default class ObsidianLiveSyncPlugin extends Plugin {
    settings: LiveSyncSettings = DEFAULT_SETTINGS;
    provider: WebsocketProvider | null = null;
    ydoc: Y.Doc | null = null;
    awareness: Awareness | null = null;
    currentFile: TFile | null = null;
    isConnected = false;

    async onload() {
        await this.loadSettings();

        // Add settings tab
        this.addSettingTab(new LiveSyncSettingTab(this.app, this));

        // Register commands
        this.addCommand({
            id: 'connect-to-server',
            name: 'Connect to Live Sync Server',
            callback: () => this.connectToServer(),
        });

        this.addCommand({
            id: 'disconnect-from-server',
            name: 'Disconnect from Live Sync Server',
            callback: () => this.disconnectFromServer(),
        });

        // Listen for file open events
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file && this.isConnected) {
                    this.setupFile(file);
                }
            })
        );

        // Listen for editor changes to update cursor position
        this.registerEditorExtension([this.cursorPlugin()]);

        new Notice('Live Sync plugin loaded');
    }

    async onunload() {
        this.disconnectFromServer();
        new Notice('Live Sync plugin unloaded');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    connectToServer() {
        if (!this.settings.serverUrl) {
            new Notice('Please configure the server URL in settings');
            return;
        }

        if (this.provider) {
            this.disconnectFromServer();
        }

        try {
            // Create Y.Doc
            this.ydoc = new Y.Doc();

            // Parse the server URL and add token
            const url = new URL(this.settings.serverUrl);
            url.searchParams.set('token', this.settings.token);

            // Create WebSocket provider
            this.provider = new WebsocketProvider(url.toString(), 'default-room', this.ydoc, {
                connect: true,
            });

            this.awareness = this.provider.awareness;

            // Set local user state
            this.awareness.setLocalStateField('user', {
                name: this.settings.userName,
                color: this.settings.userColor || generateRandomColor(),
            });

            // Handle connection status
            this.provider.on('status', (event: { status: string }) => {
                this.isConnected = event.status === 'connected';
                if (this.isConnected) {
                    new Notice(`Connected to ${this.settings.serverUrl}`);
                    
                    // Setup current file if any
                    const activeFile = this.app.workspace.getActiveFile();
                    if (activeFile) {
                        this.setupFile(activeFile);
                    }
                } else {
                    new Notice(`Disconnected from ${this.settings.serverUrl}`);
                }
            });

            // Handle awareness updates
            this.awareness.on('change', ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }) => {
                // Cursor positions will be handled by the editor extension
                console.log('Awareness change:', { added, updated, removed });
            });

        } catch (error) {
            console.error('Failed to connect:', error);
            new Notice('Failed to connect to server');
        }
    }

    disconnectFromServer() {
        if (this.provider) {
            this.provider.destroy();
            this.provider = null;
        }
        if (this.ydoc) {
            this.ydoc.destroy();
            this.ydoc = null;
        }
        this.awareness = null;
        this.isConnected = false;
        this.currentFile = null;
    }

    setupFile(file: TFile) {
        if (!this.ydoc || !this.provider) {
            return;
        }

        this.currentFile = file;

        // Use file path as room name for per-file synchronization
        const roomName = file.path.replace(/\//g, '-').replace(/[^a-zA-Z0-9-]/g, '');
        
        // Destroy old provider and create new one for this room
        this.provider.destroy();
        this.ydoc.destroy();

        this.ydoc = new Y.Doc();
        const url = new URL(this.settings.serverUrl);
        url.searchParams.set('token', this.settings.token);

        this.provider = new WebsocketProvider(url.toString(), roomName, this.ydoc, {
            connect: true,
        });

        this.awareness = this.provider.awareness;
        this.awareness.setLocalStateField('user', {
            name: this.settings.userName,
            color: this.settings.userColor || generateRandomColor(),
        });

        // Get or create text type for this document
        const ytext = this.ydoc.getText('content');

        // Read current file content and set as initial value if empty
        this.app.vault.read(file).then((content) => {
            if (ytext.length === 0 && content) {
                ytext.insert(0, content);
            }
        });

        // Setup editor integration
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView?.editor) {
            this.setupEditorIntegration(activeView.editor, ytext);
        }

        new Notice(`Syncing: ${file.name}`);
    }

    setupEditorIntegration(editor: Editor, ytext: Y.Text) {
        // This is a simplified approach - in production you'd use y-codemirror properly
        // For now, we'll do basic sync
        
        let isUpdating = false;

        // Listen to Yjs changes
        ytext.observe((event) => {
            if (isUpdating) return;
            
            const newValue = ytext.toString();
            const currentValue = editor.getValue();
            
            if (newValue !== currentValue) {
                isUpdating = true;
                const cursorPos = editor.getCursor();
                editor.setValue(newValue);
                editor.setCursor(cursorPos);
                isUpdating = false;
            }
        });

        // Listen to editor changes - use Obsidian's change event
        const editorAny = editor as any;
        if (editorAny.cm?.onChange) {
            editorAny.cm.onChange(() => {
                if (isUpdating || !this.ydoc) return;
                
                const newValue = editor.getValue();
                const currentValue = ytext.toString();
                
                if (newValue !== currentValue) {
                    isUpdating = true;
                    this.ydoc.transact(() => {
                        ytext.delete(0, ytext.length);
                        ytext.insert(0, newValue);
                    });
                    isUpdating = false;
                }
            });
        }
    }

    cursorPlugin() {
        // Annotation type for remote selections (not used directly but kept for reference)
        // const yRemoteSelectionsAnnotation: AnnotationType<Array<number>> = AnnotationType.define<number[]>();

        class YRemoteCaretWidget extends WidgetType {
            color: string;
            name: string;

            constructor(color: string, name: string) {
                super();
                this.color = color;
                this.name = name;
            }

            toDOM(view: any) {
                const caret = document.createElement('span');
                caret.className = 'cm-ySelectionCaret';
                caret.style.backgroundColor = this.color;
                caret.style.borderColor = this.color;
                caret.innerHTML = '\u2060';
                
                const dot = document.createElement('div');
                dot.className = 'cm-ySelectionCaretDot';
                caret.appendChild(dot);
                
                const label = document.createElement('div');
                label.className = 'cm-ySelectionInfo';
                label.textContent = this.name;
                label.style.backgroundColor = this.color;
                caret.appendChild(label);
                
                caret.appendChild(document.createTextNode('\u2060'));
                
                return caret;
            }

            eq(other: YRemoteCaretWidget) {
                return other.color === this.color && other.name === this.name;
            }
        }

        return ViewPlugin.fromClass(
            class {
                plugin: ObsidianLiveSyncPlugin;
                decorations: DecorationSet = Decoration.none;

                constructor(view: any) {
                    this.plugin = (view as any).plugin as ObsidianLiveSyncPlugin;
                }

                update(update: any) {
                    if (!this.plugin.awareness || !this.plugin.settings.enableCursors) {
                        this.decorations = Decoration.none;
                        return;
                    }

                    const awareness = this.plugin.awareness;
                    const decorations: Array<any> = [];

                    // Update local cursor position
                    if (update.view.hasFocus) {
                        const selection = update.state.selection.main;
                        if (selection) {
                            awareness.setLocalStateField('cursor', {
                                anchor: selection.anchor,
                                head: selection.head,
                            });
                        }
                    }

                    // Render remote cursors
                    awareness.getStates().forEach((state, clientid) => {
                        if (clientid === awareness.doc.clientID) return;
                        
                        const cursor = state.cursor;
                        if (!cursor) return;

                        const user = state.user || { name: 'Anonymous', color: '#999' };
                        
                        decorations.push({
                            from: cursor.head,
                            to: cursor.head,
                            value: Decoration.widget({
                                widget: new YRemoteCaretWidget(user.color, user.name),
                                side: 1,
                            }),
                        });
                    });

                    this.decorations = Decoration.set(decorations, true);
                }
            },
            {
                decorations: (v) => v.decorations,
            }
        );
    }
}

class LiveSyncSettingTab extends PluginSettingTab {
    plugin: ObsidianLiveSyncPlugin;

    constructor(app: App, plugin: ObsidianLiveSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('WebSocket server URL (e.g., ws://localhost:8080)')
            .addText((text) =>
                text
                    .setPlaceholder('ws://localhost:8080')
                    .setValue(this.plugin.settings.serverUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.serverUrl = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Authentication Token')
            .setDesc('Token for server authentication')
            .addText((text) =>
                text
                    .setPlaceholder('Enter token')
                    .setValue(this.plugin.settings.token)
                    .onChange(async (value) => {
                        this.plugin.settings.token = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('User Name')
            .setDesc('Your display name for cursors')
            .addText((text) =>
                text
                    .setPlaceholder('Anonymous')
                    .setValue(this.plugin.settings.userName)
                    .onChange(async (value) => {
                        this.plugin.settings.userName = value;
                        await this.plugin.saveSettings();
                        // Update awareness if connected
                        if (this.plugin.awareness) {
                            this.plugin.awareness.setLocalStateField('user', {
                                name: value,
                                color: this.plugin.settings.userColor,
                            });
                        }
                    })
            );

        new Setting(containerEl)
            .setName('User Color')
            .setDesc('Color for your cursor')
            .addText((text) =>
                text
                    .setPlaceholder('#007bff')
                    .setValue(this.plugin.settings.userColor)
                    .onChange(async (value) => {
                        this.plugin.settings.userColor = value;
                        await this.plugin.saveSettings();
                        // Update awareness if connected
                        if (this.plugin.awareness) {
                            this.plugin.awareness.setLocalStateField('user', {
                                name: this.plugin.settings.userName,
                                color: value,
                            });
                        }
                    })
            );

        new Setting(containerEl)
            .setName('Enable Cursors')
            .setDesc('Show remote user cursors')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableCursors)
                    .onChange(async (value) => {
                        this.plugin.settings.enableCursors = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Connection Status')
            .setDesc(this.plugin.isConnected ? '🟢 Connected' : '🔴 Disconnected')
            .addButton((button) =>
                button
                    .setButtonText(this.plugin.isConnected ? 'Disconnect' : 'Connect')
                    .onClick(() => {
                        if (this.plugin.isConnected) {
                            this.plugin.disconnectFromServer();
                        } else {
                            this.plugin.connectToServer();
                        }
                        this.display();
                    })
            );
    }
}
