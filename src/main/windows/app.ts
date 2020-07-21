import {
  BrowserWindow,
  app,
  screen,
  globalShortcut,
  ipcMain,
  dialog,
  nativeImage,
} from 'electron';
import { resolve, join } from 'path';
import { platform } from 'os';
import { windowManager, Window } from 'node-window-manager';
import { TOOLBAR_HEIGHT } from '~/renderer/views/app/constants/design';
import { ProcessWindow } from '../process-window';
import { Container } from '../container';
import * as fileIcon from 'extract-file-icon';
import { iohook } from '..';
import { MenuWindow } from './menu';
import Vibrant = require('node-vibrant');

const containsPoint = (bounds: any, point: any) => {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x <= bounds.x + bounds.width &&
    point.y <= bounds.y + bounds.height
  );
};

export class AppWindow extends BrowserWindow {
  public containers: Container[] = [];
  public selectedContainer: Container;

  public menu = new MenuWindow(this);

  public draggedWindow: ProcessWindow;

  public draggedIn = false;
  public detached = false;
  public willAttachWindow = false;
  public willSplitWindow = false;
  public isMoving = false;
  public isUpdatingContentBounds = false;

  public interval: any;

  private height = 700;

  private attachingEnabled = true;
  private draggedContainer: Container;

  public window: Window;

  public constructor() {
    super({
      frame: false,
      width: 900,
      height: 700,
      minimizable: platform() !== 'darwin',
      maximizable: platform() !== 'darwin',
      show: true,
      fullscreenable: false,
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        plugins: true,
        nodeIntegration: true,
      },
      icon: resolve(app.getAppPath(), 'static/app-icons/icon.png'),
    });

    const { x, y } = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint({ x, y });
    this.setPosition(currentDisplay.workArea.x, currentDisplay.workArea.y);
    this.center();

    process.on('uncaughtException', (error) => {
      console.error(error);
    });

    if (process.env.ENV === 'dev') {
      this.webContents.openDevTools({ mode: 'detach' });

      this.loadURL('http://localhost:4444/app.html');
    } else {
      this.loadURL(join('file://', app.getAppPath(), 'build/app.html'));
    }

    if (platform() === 'win32' || platform() === 'darwin') {
      this.activateWindowCapturing();
    }
  }

  public activateWindowCapturing() {
    windowManager.requestAccessibility();

    if (process.platform === 'win32') {
      this.window = new Window(this.getHandle());
    }

    const updateBounds = () => {
      this.isMoving = true;

      if (platform() === 'darwin') {
        for (const c of this.containers) {
          if (
            c &&
            ((this.selectedContainer !== c && this.isUpdatingContentBounds) ||
              !this.isUpdatingContentBounds)
          ) {
            c.rearrangeWindows();
          }
        }
      } else if (!this.isUpdatingContentBounds && this.selectedContainer) {
        this.selectedContainer.rearrangeWindows();
      }
    };

    this.on('move', updateBounds);
    this.on('resize', updateBounds);

    this.on('close', () => {
      clearInterval(this.interval);

      for (const container of this.containers) {
        for (const window of container.windows) {
          window.show();
          container.detachWindow(window);
        }
      }
    });

    this.interval = setInterval(this.intervalCallback, 100);

    ipcMain.on('select-window', (e, id: number) => {
      this.selectContainer(this.containers.find((x) => x.id === id));
    });

    ipcMain.on('new-tab', () => {
      this.newTab();
    });

    ipcMain.on('detach-window', (e, id: number) => {
      for (const container of this.containers) {
        container.removeWindow(id, true);
      }
      this.draggedWindow = null;
    });

    ipcMain.on(`menu-toggle-${this.id}`, () => {
      this.menu.toggle();
    });

    ipcMain.on(`toggle-attaching-${this.id}`, (e, value) => {
      this.attachingEnabled = value;
    });

    ipcMain.on(`get-title-${this.id}`, (e) => {
      e.returnValue = this.getTitle();
    });

    ipcMain.on(`set-title-${this.id}`, (e, title) => {
      this.setTitle(title);
    });

    ipcMain.on(`change-icon-${this.id}`, async () => {
      const dialogRes = await dialog.showOpenDialog(this, {
        filters: [{ name: 'All Files', extensions: ['*'] }],
      });

      this.setIcon(nativeImage.createFromPath(dialogRes.filePaths[0]));
    });

    windowManager.on('window-activated', (window: Window) => {
      this.controlShortcuts(window.id);

      if (!this.isFocused()) return;

      for (const container of this.containers) {
        if (container.windows.find((x) => x.id === window.id)) {
          this.webContents.send('select-tab', container.id);
          break;
        }
      }
    });

    iohook.on('mousedown', ({ x, y }: any) => {
      if (this.isMinimized()) return;

      setTimeout(() => {
        if (
          y >= this.getBounds().y &&
          y <= this.getBounds().y + TOOLBAR_HEIGHT
        ) {
          this.draggedWindow = null;
          return;
        }

        const id = windowManager.getActiveWindow().id;

        if (this.selectedContainer) {
          const win = this.selectedContainer.windows.find((x) => x.id === id);
          this.draggedWindow = win;
        }

        if (!this.draggedWindow) {
          this.draggedWindow = new ProcessWindow(id, this);
        }
      }, 50);
    });

    iohook.on('mousedrag', async (e: any) => {
      this.mouseDragWindow(e);
    });

    iohook.on('mouseup', async (e: any) => {
      this.isMoving = false;

      if (process.platform === 'win32' && this.isFocused()) {
        if (this.selectedContainer) {
          for (const w of this.selectedContainer.windows) {
            w.bringToTop();
          }
        }
      }

      if (this.isUpdatingContentBounds) {
        setTimeout(() => {
          if (this.selectedContainer) {
            this.selectedContainer.rearrangeWindows();
          }
        }, 100);
      }

      this.isUpdatingContentBounds = false;

      for (const container of this.containers) {
        for (const window of container.windows) {
          window.dragged = false;
          window.resizing = false;
        }
      }

      if (this.draggedWindow) {
        this.draggedWindow.dragged = false;
        this.draggedWindow.resizing = false;

        if (this.willAttachWindow) {
          this.attachNewContainer(this.draggedContainer, this.draggedWindow);
        } else if (this.willSplitWindow && !this.detached) {
          this.willSplitWindow = false;

          if (this.selectedContainer) this.selectedContainer.rearrangeWindows();
        }
      }

      setTimeout(() => {
        this.mouseDragWindow(e);
        this.detached = false;
        this.draggedWindow = null;
        this.draggedContainer = null;
        this.draggedIn = false;
      }, 50);

      this.draggedContainer = null;
      this.draggedIn = false;
    });
  }

  private controlShortcuts(id: number) {
    this.controlShortcut(id, 'CmdOrCtrl+Tab', () => {
      this.webContents.send('next-tab');
    });

    this.controlShortcut(id, 'CmdOrCtrl+Shift+Tab', () => {
      this.webContents.send('previous-tab');
    });
  }

  private controlShortcut(
    id: number,
    accelerator: string,
    callback: () => void,
  ) {
    if (
      this.containers.find((x) => x.windows.find((y) => y.id === id)) ||
      this.isFocused()
    ) {
      if (!globalShortcut.isRegistered(accelerator)) {
        globalShortcut.register(accelerator, () => {
          callback();
        });
      }
    } else if (globalShortcut.isRegistered(accelerator)) {
      globalShortcut.unregister(accelerator);
    }
  }

  private intervalCallback = () => {
    if (!this.isMinimized()) {
      for (const container of this.containers) {
        if (!container) return;

        if (container.windows.length === 1) {
          const window = container.windows[0];
          const title = window.getTitle();
          if (window.lastTitle !== title) {
            this.webContents.send('update-tab-title', {
              id: container.id,
              title,
            });
            window.lastTitle = title;
          }
        }

        for (const window of container.windows) {
          if (!window.isWindow()) {
            container.removeWindow(window.id);
          }
        }
      }
    }
  };

  public mouseDragWindow(e: any) {
    if (
      !this.isMinimized() &&
      this.draggedWindow &&
      this.attachingEnabled &&
      !this.isFocused()
    ) {
      if (this.draggedWindow.getTitle() === app.name) return;
      const winBounds = this.draggedWindow.getBounds();
      const { lastBounds } = this.draggedWindow;
      const contentBounds = this.getContentArea();
      const scaleFactor = this.draggedWindow.getMonitor().getScaleFactor();

      const realY = Math.floor(e.y / scaleFactor);
      e.y = winBounds.y;
      e.x = Math.floor(e.x / scaleFactor);

      contentBounds.y -= TOOLBAR_HEIGHT;

      if (this.containers.length > 0) {
        contentBounds.height = TOOLBAR_HEIGHT;
      }

      const windowAttached =
        this.selectedContainer &&
        this.selectedContainer.windows.find(
          (x) => x.id === this.draggedWindow.id,
        );

      if (this.selectedContainer) {
        if (
          windowAttached &&
          (winBounds.width !== lastBounds.width ||
            winBounds.height !== lastBounds.height)
        ) {
          this.selectedContainer.resizeWindow(this.draggedWindow, () => {
            this.isUpdatingContentBounds = true;

            const cBounds = this.getContentBounds();

            this.setContentBounds({
              width: cBounds.width + (winBounds.width - lastBounds.width),
              height:
                platform() !== 'darwin'
                  ? cBounds.height + (winBounds.height - lastBounds.height)
                  : TOOLBAR_HEIGHT,
              x: cBounds.x + winBounds.x - lastBounds.x,
              y: cBounds.y + winBounds.y - lastBounds.y,
            } as any);

            this.height = this.height + winBounds.height - lastBounds.height;

            this.draggedWindow.lastBounds = winBounds;
          });
        } else if (
          !this.draggedWindow.resizing &&
          (winBounds.x !== lastBounds.x || winBounds.y !== lastBounds.y) &&
          winBounds.width === lastBounds.width &&
          winBounds.height === lastBounds.height &&
          realY - winBounds.y <= 42
        ) {
          this.selectedContainer.dragWindow(this.draggedWindow, e);
          if (!this.detached) {
            this.willSplitWindow = true;
          }
        }
      }

      if (containsPoint(contentBounds, e) && !this.draggedWindow.resizing) {
        if (
          !this.draggedIn &&
          !windowAttached &&
          !this.detached &&
          realY - winBounds.y <= 42
        ) {
          const win = this.draggedWindow;

          if (this.selectedContainer) {
            this.selectedContainer.removeWindow(win.id, e.type === 'mouseup');
          }

          const container = this.prepareContainer(this.draggedWindow);

          this.draggedContainer = container;

          this.draggedIn = true;
          this.willAttachWindow = true;
        }
      } else if (this.draggedIn && this.draggedContainer) {
        this.webContents.send('remove-tab', this.draggedContainer.id);

        this.draggedIn = false;
        this.willAttachWindow = false;
      }
    }
  }

  public prepareContainer(window: ProcessWindow, dragged = true) {
    const container = new Container(this, window, dragged);

    const title = window.getTitle();
    const icon = fileIcon(window.path, 16);

    window.lastTitle = title;

    this.webContents.send('add-tab', {
      id: container.id,
      title,
      icon,
    });

    try {
      Vibrant.from(icon)
        .getPalette()
        .then((palette) => {
          this.webContents.send(
            'tab-background',
            container.id,
            palette.Vibrant.hex,
          );
        });
    } catch (e) {
      console.error(e);
    }

    return container;
  }

  public attachNewContainer(container: Container, win: ProcessWindow) {
    if (platform() === 'win32') {
      const handle = this.getNativeWindowHandle().readInt32LE(0);
      win.setOwner(handle);
    }

    if (platform() === 'darwin' && this.containers.length === 0) {
      this.setBounds({ height: TOOLBAR_HEIGHT } as any);
      this.setMaximumSize(0, TOOLBAR_HEIGHT);
    }

    this.containers.push(container);
    this.willAttachWindow = false;

    container.rearrangeWindows();

    setTimeout(() => {
      this.selectContainer(container);
    }, 50);

    this.controlShortcuts(win.id);
  }

  public async newTab() {
    if (this.selectedContainer?.windows?.length === 1) {
      const window = await this.createNewWindow(
        this.selectedContainer.windows[0].path,
      );

      this.addTabWithWindow(window);
    }
  }

  public createNewWindow(path: string): Promise<ProcessWindow> {
    return new Promise((resolve, reject) => {
      windowManager.createProcess(path);

      const timeout = setTimeout(() => {
        reject(new Error('Creating new window timed out'));
      }, 5000);

      windowManager.once('window-activated', (win: ProcessWindow) => {
        if (win.path === path) {
          clearTimeout(timeout);
          resolve(new ProcessWindow(win.id, this));
        }
      });
    });
  }

  public addTabWithWindow(win: ProcessWindow) {
    const container = this.prepareContainer(win, false);
    this.attachNewContainer(container, win);
  }

  public getContentArea() {
    const bounds = this.getContentBounds();

    if (platform() === 'darwin') {
      bounds.height = this.height;
    }

    bounds.y += TOOLBAR_HEIGHT;
    bounds.height -= TOOLBAR_HEIGHT;

    return bounds;
  }

  public selectContainer(container: Container) {
    if (!container) return;

    if (this.selectedContainer) {
      if (container.id === this.selectedContainer.id) {
        return;
      }

      this.selectedContainer.hideWindows();
    }

    container.showWindows();
    this.selectedContainer = container;
  }

  public removeContainer(container: Container) {
    if (this.selectedContainer === container) {
      this.selectedContainer = null;
    }

    this.webContents.send('remove-tab', container.id);
    this.containers = this.containers.filter((x) => x.id !== container.id);

    if (platform() === 'darwin' && this.containers.length === 0) {
      this.setBounds({ height: this.height } as any);
      this.setMaximumSize(0, 0);
    }
  }

  public getHandle = () => this.getNativeWindowHandle().readInt32LE(0);
}
