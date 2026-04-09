export class TFile {
  path: string;
  name: string;
  stat = { mtime: 0 };
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() || path;
  }
}

export class TAbstractFile {
  path = "";
}

export class Notice {
  constructor(_msg: string) {}
}

export class App {}
export class Editor {}
