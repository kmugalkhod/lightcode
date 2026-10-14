import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { NativeDirectoryPickerError } from "../lib/native-directory-picker";
import { createWebSecurityMiddleware } from "../lib/web-auth";
import {
  createWorkspaceRoutes,
  isFilesystemRootPath,
  resolveDesktopDirectoryPath,
  resolveDocumentsDirectoryPath,
  resolveDownloadsDirectoryPath,
  resolveProjectsDirectoryPath,
} from "./workspace-routes";

const temporaryDirectories: string[] = [];

async function makeDesktop() {
  const parent = await mkdtemp(path.join(tmpdir(), "lightcode-desktop-"));
  temporaryDirectories.push(parent);
  const desktop = path.join(parent, "Desktop");
  await mkdir(desktop);
  return { parent, desktop };
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function openDesktop(app: ReturnType<typeof createWorkspaceRoutes>) {
  return openLocation(app, "desktop");
}

async function openLocation(
  app: ReturnType<typeof createWorkspaceRoutes>,
  locationId: "desktop" | "home" | "documents" | "downloads" | "projects",
) {
  const response = await app.request(
    "/browser/open",
    jsonRequest({ locationId }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { browserId: string };
  return body.browserId;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("filesystem root guard", () => {
  test("recognizes POSIX, Windows drive, and UNC share roots", () => {
    expect(isFilesystemRootPath("/", "linux")).toBe(true);
    expect(isFilesystemRootPath("/workspace", "linux")).toBe(false);
    expect(isFilesystemRootPath("C:\\", "win32")).toBe(true);
    expect(isFilesystemRootPath("D:\\", "win32")).toBe(true);
    expect(isFilesystemRootPath("C:\\workspace", "win32")).toBe(false);
    expect(isFilesystemRootPath("\\\\server\\share\\", "win32")).toBe(true);
    expect(
      isFilesystemRootPath("\\\\server\\share\\workspace", "win32"),
    ).toBe(false);
  });
});

describe("native workspace picker route", () => {
  test("accepts only an empty object and treats cancellation as success", async () => {
    let calls = 0;
    const app = createWorkspaceRoutes({
      authorizeNativePickerRequest: () => true,
      nativeDirectoryPicker: {
        pick: async () => {
          calls += 1;
          return { outcome: "cancelled" };
        },
      },
    });

    const rejected = await app.request(
      "/picker/open",
      jsonRequest({ path: "/tmp/browser-controlled" }),
    );
    expect(rejected.status).toBe(400);
    expect(calls).toBe(0);

    const cancelled = await app.request("/picker/open", jsonRequest({}));
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ outcome: "cancelled" });
    expect(calls).toBe(1);
  });

  test("canonicalizes a selected folder and creates a session through its grant", async () => {
    const { desktop } = await makeDesktop();
    let sessionCwd = "";
    const sessionId = crypto.randomUUID();
    const app = createWorkspaceRoutes({
      authorizeNativePickerRequest: () => true,
      nativeDirectoryPicker: {
        pick: async () => ({ outcome: "selected", directory: desktop }),
      },
      createSession: async (input) => {
        sessionCwd = input?.cwd ?? "";
        return { id: sessionId };
      },
    });

    const selected = await app.request("/picker/open", jsonRequest({}));
    expect(selected.status).toBe(201);
    const body = (await selected.json()) as {
      outcome: string;
      workspace: { id: string; name: string; pathLabel: string };
    };
    expect(body).toMatchObject({
      outcome: "selected",
      workspace: { name: "Desktop", pathLabel: await realpath(desktop) },
    });

    const session = await app.request(
      `/${body.workspace.id}/sessions`,
      jsonRequest({}),
    );
    expect(session.status).toBe(201);
    expect(await session.json()).toEqual({ id: sessionId });
    expect(sessionCwd).toBe(await realpath(desktop));
  });

  for (const [error, status, code, retryable] of [
    [
      new NativeDirectoryPickerError(
        "native_picker_busy",
        "A folder picker is already open.",
      ),
      409,
      "native_picker_busy",
      true,
    ],
    [
      new NativeDirectoryPickerError(
        "native_picker_unavailable",
        "No supported system folder picker is available.",
      ),
      503,
      "native_picker_unavailable",
      false,
    ],
    [new Error("process details must remain hidden"), 500, "native_picker_failed", true],
  ] as const) {
    test(`maps ${code} without exposing process details`, async () => {
      const app = createWorkspaceRoutes({
        authorizeNativePickerRequest: () => true,
        nativeDirectoryPicker: { pick: async () => Promise.reject(error) },
      });
      const response = await app.request("/picker/open", jsonRequest({}));
      expect(response.status).toBe(status);
      const payload = (await response.json()) as {
        code: string;
        error: string;
        retryable: boolean;
      };
      expect(payload).toMatchObject({ code, retryable });
      expect(payload.error).not.toContain("process details");
    });
  }

  test("keeps the stderr diagnostic out of the HTTP response", async () => {
    const secret = "C:\\Users\\private\\stderr-only";
    const app = createWorkspaceRoutes({
      authorizeNativePickerRequest: () => true,
      nativeDirectoryPicker: {
        pick: async () =>
          Promise.reject(
            new NativeDirectoryPickerError(
              "native_picker_failed",
              "The Windows folder picker could not be opened.",
              `failure near ${secret}`,
            ),
          ),
      },
    });
    const response = await app.request("/picker/open", jsonRequest({}));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(JSON.parse(text)).toEqual({
      error: "The system folder picker could not be opened.",
      code: "native_picker_failed",
      retryable: true,
    });
  });

  test("passes the client abort to the picker through a capped signal", async () => {
    const client = new AbortController();
    let pickerSignal: AbortSignal | undefined;
    let pickerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pickerStarted = resolve;
    });
    const app = createWorkspaceRoutes({
      authorizeNativePickerRequest: () => true,
      nativeDirectoryPicker: {
        pick: (signal) => {
          pickerSignal = signal;
          pickerStarted();
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () =>
              resolve({ outcome: "cancelled" }),
            );
          });
        },
      },
    });

    const request = new Request("http://localhost/picker/open", {
      ...jsonRequest({}),
      signal: client.signal,
    });
    const pending = app.request(request);
    await started;
    expect(pickerSignal).toBeDefined();
    expect(pickerSignal).not.toBe(request.signal);
    expect(pickerSignal?.aborted).toBe(false);
    client.abort();
    const response = await pending;
    expect(pickerSignal?.aborted).toBe(true);
    expect(await response.json()).toEqual({ outcome: "cancelled" });
  });

  test("can be triggered only by an authenticated same-origin web request", async () => {
    const expectedOrigin = "http://127.0.0.1:4983";
    const token = Buffer.alloc(32, 9).toString("base64url");
    let calls = 0;
    const routes = createWorkspaceRoutes({
      nativeDirectoryPicker: {
        pick: async () => {
          calls += 1;
          return { outcome: "cancelled" };
        },
      },
    });
    const app = new Hono()
      .use(
        "*",
        createWebSecurityMiddleware({
          expectedOrigin,
          authState: { available: true, token },
        }),
      )
      .route("/workspaces", routes);
    const browserHeaders = {
      authorization: `Bearer ${token}`,
      host: "127.0.0.1:4983",
      origin: expectedOrigin,
      "content-type": "application/json",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": "Mozilla/5.0",
    };

    const valid = await app.request(`${expectedOrigin}/workspaces/picker/open`, {
      ...jsonRequest({}),
      headers: browserHeaders,
    });
    expect(valid.status).toBe(200);

    const bearerOnly = await app.request(
      `${expectedOrigin}/workspaces/picker/open`,
      {
        ...jsonRequest({}),
        headers: {
          authorization: `Bearer ${token}`,
          host: "127.0.0.1:4983",
          "content-type": "application/json",
        },
      },
    );
    expect(bearerOnly.status).toBe(403);
    expect(await bearerOnly.json()).toMatchObject({
      code: "web_browser_required",
    });

    const wrongOrigin = await app.request(
      `${expectedOrigin}/workspaces/picker/open`,
      {
        ...jsonRequest({}),
        headers: { ...browserHeaders, origin: "http://127.0.0.1:9999" },
      },
    );
    expect(wrongOrigin.status).toBe(403);
    expect(calls).toBe(1);
  });
});

describe("drives location", () => {
  async function drivesApp() {
    const { parent } = await makeDesktop();
    await mkdir(path.join(parent, "Self-Project", "lightcode"), {
      recursive: true,
    });
    const app = createWorkspaceRoutes({
      enableDrives: true,
      listDrives: async () => [
        { token: "X:", readable: true },
        { token: "Y:", readable: false },
      ],
      driveRoot: (token) => (token === "X:" ? parent : path.join(parent, "nope")),
    });
    return { app, parent };
  }

  async function openDrives(app: ReturnType<typeof createWorkspaceRoutes>) {
    const locations = (await (await app.request("/locations")).json()) as {
      locations: Array<{ id: string; kind: string }>;
    };
    expect(locations.locations.at(-1)).toMatchObject({
      id: "drives",
      kind: "drives",
    });
    const response = await app.request(
      "/browser/open",
      jsonRequest({ locationId: "drives" }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { browserId: string }).browserId;
  }

  test("lists drives, browses into one, and grants only a folder inside it", async () => {
    const { app, parent } = await drivesApp();
    const browserId = await openDrives(app);

    const drives = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({}),
    );
    expect(await drives.json()).toMatchObject({
      segments: [],
      entries: [
        { name: "X:", kind: "directory", readable: true },
        { name: "Y:", kind: "directory", readable: false },
      ],
    });

    const inside = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({ segments: ["X:", "Self-Project"] }),
    );
    expect(inside.status).toBe(200);
    expect(await inside.json()).toMatchObject({
      entries: [{ name: "lightcode", kind: "directory" }],
    });

    for (const segments of [[], ["X:"]]) {
      const root = await app.request(
        `/browser/${browserId}/select`,
        jsonRequest({ segments }),
      );
      expect(root.status).toBe(422);
      expect(await root.json()).toMatchObject({
        code: "drive_root_not_selectable",
      });
    }

    const selected = await app.request(
      `/browser/${browserId}/select`,
      jsonRequest({ segments: ["X:", "Self-Project", "lightcode"] }),
    );
    expect(selected.status).toBe(201);
    const canonical = await realpath(
      path.join(parent, "Self-Project", "lightcode"),
    );
    expect(await selected.json()).toMatchObject({
      workspace: { name: "lightcode", pathLabel: canonical },
    });
  });

  test.skipIf(process.platform !== "win32")(
    "browses a real drive root rather than the current folder on that drive",
    async () => {
      const { desktop } = await makeDesktop();
      const canonical = await realpath(desktop);
      const { root } = path.win32.parse(canonical);
      const drive = root.slice(0, 2).toUpperCase();
      const [firstFolder, ...rest] = canonical
        .slice(root.length)
        .split("\\")
        .filter(Boolean);
      const app = createWorkspaceRoutes({ enableDrives: true });
      const browserId = await openDrives(app);
      await app.request(`/browser/${browserId}/entries`, jsonRequest({}));

      const driveListing = await app.request(
        `/browser/${browserId}/entries`,
        jsonRequest({ segments: [drive], directoriesOnly: true, limit: 200 }),
      );
      expect(driveListing.status).toBe(200);
      const { entries } = (await driveListing.json()) as {
        entries: Array<{ name: string }>;
      };
      // Bun's async realpath turns "C:\" into "C:" (the cwd on C:).
      expect(entries.map((entry) => entry.name.toLowerCase())).toContain(
        firstFolder?.toLowerCase(),
      );

      const selected = await app.request(
        `/browser/${browserId}/select`,
        jsonRequest({ segments: [drive, firstFolder, ...rest] }),
      );
      expect(selected.status).toBe(201);
      expect(await selected.json()).toMatchObject({
        workspace: { pathLabel: canonical },
      });
    },
    20_000,
  );

  test("accepts only drive tokens the server listed", async () => {
    const { app } = await drivesApp();
    const browserId = await openDrives(app);

    // Not listed yet: the drive list must be read before a drive opens.
    const early = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({ segments: ["X:"] }),
    );
    expect(early.status).toBe(404);

    await app.request(`/browser/${browserId}/entries`, jsonRequest({}));
    for (const token of ["Q:", "x:", "X", "C:foo", "..", "X:\\"]) {
      const response = await app.request(
        `/browser/${browserId}/entries`,
        jsonRequest({ segments: [token] }),
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("recent projects", () => {
  test("lists distinct recent folders with opaque keys and grants by key", async () => {
    const { desktop, parent } = await makeDesktop();
    const missing = path.join(parent, "deleted-project");
    const canonical = await realpath(desktop);
    const app = createWorkspaceRoutes({
      authorizeNativePickerRequest: () => true,
      listRecentWorkspaces: async () => [
        {
          cwd: canonical,
          identity: null,
          lastUsedAt: new Date("2026-10-14T00:00:00.000Z"),
        },
        {
          cwd: missing,
          identity: null,
          lastUsedAt: new Date("2026-10-13T00:00:00.000Z"),
        },
      ],
    });

    const listed = await app.request("/recent");
    expect(listed.status).toBe(200);
    const { projects } = (await listed.json()) as {
      projects: Array<{
        key: string;
        name: string;
        pathLabel: string;
        available: boolean;
      }>;
    };
    expect(projects).toMatchObject([
      { name: "Desktop", pathLabel: canonical, available: true },
      { name: "deleted-project", pathLabel: missing, available: false },
    ]);
    const [present, deleted] = projects;
    expect(present?.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(present?.key).not.toContain("Desktop");

    const granted = await app.request(
      `/recent/${present?.key}/grant`,
      jsonRequest({}),
    );
    expect(granted.status).toBe(201);
    expect(await granted.json()).toMatchObject({
      workspace: { name: "Desktop", pathLabel: canonical, hostPath: canonical },
    });

    const gone = await app.request(
      `/recent/${deleted?.key}/grant`,
      jsonRequest({}),
    );
    expect(gone.status).toBe(404);

    const tampered = await app.request(
      `/recent/${"A".repeat(22)}/grant`,
      jsonRequest({}),
    );
    expect(tampered.status).toBe(404);
    const malformed = await app.request(
      `/recent/${encodeURIComponent(canonical)}/grant`,
      jsonRequest({}),
    );
    expect(malformed.status).toBe(400);
  });

  test("leaves filesystem roots out of recent projects", async () => {
    const { desktop } = await makeDesktop();
    const canonical = await realpath(desktop);
    const app = createWorkspaceRoutes({
      listRecentWorkspaces: async () => [
        {
          cwd: path.parse(canonical).root,
          identity: null,
          lastUsedAt: new Date(),
        },
        { cwd: canonical, identity: null, lastUsedAt: new Date() },
      ],
    });
    const { projects } = (await (await app.request("/recent")).json()) as {
      projects: Array<{ pathLabel: string }>;
    };
    expect(projects.map((project) => project.pathLabel)).toEqual([canonical]);
  });

  test("refuses a recent folder whose identity changed", async () => {
    const { desktop } = await makeDesktop();
    const canonical = await realpath(desktop);
    const app = createWorkspaceRoutes({
      authorizeNativePickerRequest: () => true,
      listRecentWorkspaces: async () => [
        {
          cwd: canonical,
          identity: { device: "1", inode: "999999999" },
          lastUsedAt: new Date(),
        },
      ],
    });
    const { projects } = (await (await app.request("/recent")).json()) as {
      projects: Array<{ key: string }>;
    };
    const response = await app.request(
      `/recent/${projects[0]?.key}/grant`,
      jsonRequest({}),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "workspace_replaced" });
  });

  test("grants only to an authenticated web request", async () => {
    const { desktop } = await makeDesktop();
    const app = createWorkspaceRoutes({
      authorizeNativePickerRequest: () => false,
      listRecentWorkspaces: async () => [
        { cwd: await realpath(desktop), identity: null, lastUsedAt: new Date() },
      ],
    });
    const { projects } = (await (await app.request("/recent")).json()) as {
      projects: Array<{ key: string }>;
    };
    const response = await app.request(
      `/recent/${projects[0]?.key}/grant`,
      jsonRequest({}),
    );
    expect(response.status).toBe(403);
  });
});

describe("known-folder prewarm", () => {
  test("starts discovery when locations are listed", async () => {
    let prewarms = 0;
    const app = createWorkspaceRoutes({
      enableDrives: false,
      prewarmKnownFolders: () => {
        prewarms += 1;
      },
    });
    await app.request("/locations");
    expect(prewarms).toBe(1);
  });

  test("omits the host path for clients that are not the authenticated web app", async () => {
    const { desktop } = await makeDesktop();
    const app = createWorkspaceRoutes({ desktopPath: desktop });
    const browserId = await openDesktop(app);
    const selected = await app.request(
      `/browser/${browserId}/select`,
      jsonRequest({ segments: [] }),
    );
    const body = (await selected.json()) as { workspace: object };
    expect(body.workspace).not.toHaveProperty("hostPath");
  });
});

describe("launch folder routes", () => {
  test("reports unavailable without a usable launch folder", async () => {
    for (const launchFolderPath of [
      null,
      "relative/project",
      process.platform === "win32" ? "C:\\" : "/",
      path.join(tmpdir(), `lightcode-missing-${crypto.randomUUID()}`),
    ]) {
      const app = createWorkspaceRoutes({
        launchFolderPath,
        authorizeNativePickerRequest: () => true,
      });
      const response = await app.request("/launch-folder");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ available: false });

      const grant = await app.request(
        "/launch-folder/grant",
        jsonRequest({}),
      );
      expect(grant.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("describes and grants the canonical launch folder", async () => {
    const { desktop } = await makeDesktop();
    const canonical = await realpath(desktop);
    let sessionCwd = "";
    const app = createWorkspaceRoutes({
      launchFolderPath: desktop,
      authorizeNativePickerRequest: () => true,
      createSession: async (input) => {
        sessionCwd = input?.cwd ?? "";
        return { id: crypto.randomUUID() };
      },
    });

    const described = await app.request("/launch-folder");
    expect(await described.json()).toEqual({
      available: true,
      name: "Desktop",
      pathLabel: canonical,
      broad: false,
    });

    const granted = await app.request(
      "/launch-folder/grant",
      jsonRequest({}),
    );
    expect(granted.status).toBe(201);
    const body = (await granted.json()) as {
      workspace: { id: string; name: string; pathLabel: string };
    };
    expect(body.workspace).toMatchObject({
      name: "Desktop",
      pathLabel: canonical,
    });

    const session = await app.request(
      `/${body.workspace.id}/sessions`,
      jsonRequest({}),
    );
    expect(session.status).toBe(201);
    expect(sessionCwd).toBe(canonical);
  });

  test("flags a launch folder that contains the home directory as broad", async () => {
    const app = createWorkspaceRoutes({ launchFolderPath: homedir() });
    expect(await (await app.request("/launch-folder")).json()).toMatchObject({
      available: true,
      broad: true,
    });
  });

  test("grants only to an authenticated web request with an empty body", async () => {
    const { desktop } = await makeDesktop();
    const unauthenticated = createWorkspaceRoutes({
      launchFolderPath: desktop,
      authorizeNativePickerRequest: () => false,
    });
    const forbidden = await unauthenticated.request(
      "/launch-folder/grant",
      jsonRequest({}),
    );
    expect(forbidden.status).toBe(403);

    const authenticated = createWorkspaceRoutes({
      launchFolderPath: desktop,
      authorizeNativePickerRequest: () => true,
    });
    const smuggled = await authenticated.request(
      "/launch-folder/grant",
      jsonRequest({ path: tmpdir() }),
    );
    expect(smuggled.status).toBe(400);
  });
});

describe("Desktop known-folder resolver", () => {
  test("uses the explicit Lightcode override before platform discovery", async () => {
    await expect(
      resolveDesktopDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: {
          LIGHTCODE_DESKTOP_PATH: "/mnt/projects/Desktop",
          XDG_CONFIG_HOME: "/ignored",
        },
        probeDirectory: async () => {
          throw new Error("the explicit override must not be probed here");
        },
      }),
    ).resolves.toBe("/mnt/projects/Desktop");
  });

  test("uses a valid Linux XDG Desktop and falls back when it is disabled", async () => {
    const discovered = await resolveDesktopDirectoryPath({
      platform: "linux",
      homeDirectory: "/home/lightcode",
      environment: {},
      readUserDirsConfiguration: async (filePath) => {
        expect(filePath).toBe("/home/lightcode/.config/user-dirs.dirs");
        return 'XDG_DESKTOP_DIR="$HOME/Bureau"\n';
      },
      probeDirectory: async (candidate) =>
        candidate === "/home/lightcode/Bureau" ? "available" : "missing",
    });
    expect(discovered).toBe("/home/lightcode/Bureau");

    await expect(
      resolveDesktopDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: {},
        readUserDirsConfiguration: async () =>
          'XDG_DESKTOP_DIR="$HOME"\n',
        probeDirectory: async () => "available",
      }),
    ).resolves.toBe("/home/lightcode/Desktop");
  });

  test("prefers a present Windows OneDrive Desktop and has a home fallback", async () => {
    const oneDriveDesktop = "D:\\OneDrive\\Desktop";
    const discovered = await resolveDesktopDirectoryPath({
      platform: "win32",
      homeDirectory: "C:\\Users\\lightcode",
      environment: {
        USERPROFILE: "C:\\Users\\lightcode",
        OneDrive: "D:\\OneDrive",
      },
      resolveWindowsKnownFolder: async () => null,
      probeDirectory: async (candidate) =>
        candidate === oneDriveDesktop ? "available" : "missing",
    });
    expect(discovered).toBe(oneDriveDesktop);

    await expect(
      resolveDesktopDirectoryPath({
        platform: "win32",
        homeDirectory: "C:\\Users\\lightcode",
        environment: {},
        resolveWindowsKnownFolder: async () => null,
        probeDirectory: async () => "missing",
      }),
    ).resolves.toBe("C:\\Users\\lightcode\\Desktop");
  });

  test("honors the Windows redirected Desktop known folder", async () => {
    const redirected = "E:\\Company Folders\\Desktop";
    await expect(
      resolveDesktopDirectoryPath({
        platform: "win32",
        homeDirectory: "C:\\Users\\lightcode",
        environment: { OneDrive: "D:\\OneDrive" },
        resolveWindowsKnownFolder: async () => redirected,
        probeDirectory: async (candidate) =>
          candidate === redirected ? "available" : "missing",
      }),
    ).resolves.toBe(redirected);
  });

  test("rejects an override that would expose a filesystem root", async () => {
    await expect(
      resolveDesktopDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: { LIGHTCODE_DESKTOP_PATH: "/" },
      }),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
  });
});

describe("Documents and Downloads known-folder resolvers", () => {
  test("uses localized Linux XDG user directories", async () => {
    const configuration = [
      'XDG_DOCUMENTS_DIR="$HOME/Dokumente"',
      'XDG_DOWNLOAD_DIR="$HOME/Téléchargements"',
    ].join("\n");
    const probeDirectory = async (candidate: string) =>
      candidate === "/home/lightcode/Dokumente" ||
      candidate === "/home/lightcode/Téléchargements"
        ? ("available" as const)
        : ("missing" as const);
    const options = {
      platform: "linux" as const,
      homeDirectory: "/home/lightcode",
      environment: {},
      readUserDirsConfiguration: async (filePath: string) => {
        expect(filePath).toBe("/home/lightcode/.config/user-dirs.dirs");
        return configuration;
      },
      probeDirectory,
    };

    await expect(resolveDocumentsDirectoryPath(options)).resolves.toBe(
      "/home/lightcode/Dokumente",
    );
    await expect(resolveDownloadsDirectoryPath(options)).resolves.toBe(
      "/home/lightcode/Téléchargements",
    );
  });

  test("prefers Windows known-folder and OneDrive redirection", async () => {
    await expect(
      resolveDocumentsDirectoryPath({
        platform: "win32",
        homeDirectory: "C:\\Users\\lightcode",
        environment: { USERPROFILE: "C:\\Users\\lightcode" },
        resolveWindowsKnownFolder: async () =>
          "E:\\Company Folders\\Documents",
        probeDirectory: async (candidate) =>
          candidate === "E:\\Company Folders\\Documents"
            ? "available"
            : "missing",
      }),
    ).resolves.toBe("E:\\Company Folders\\Documents");

    await expect(
      resolveDownloadsDirectoryPath({
        platform: "win32",
        homeDirectory: "C:\\Users\\lightcode",
        environment: { OneDrive: "D:\\OneDrive" },
        resolveWindowsKnownFolder: async () => null,
        probeDirectory: async (candidate) =>
          candidate === "D:\\OneDrive\\Downloads"
            ? "available"
            : "missing",
      }),
    ).resolves.toBe("D:\\OneDrive\\Downloads");
  });

  test("honors validated overrides and rejects filesystem roots", async () => {
    await expect(
      resolveDocumentsDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: { LIGHTCODE_DOCUMENTS_PATH: "/work/docs" },
        probeDirectory: async () => {
          throw new Error("an explicit override must not be probed");
        },
      }),
    ).resolves.toBe("/work/docs");
    await expect(
      resolveDownloadsDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: { LIGHTCODE_DOWNLOADS_PATH: "/" },
      }),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
  });
});

describe("Projects known-folder resolver", () => {
  test("uses an explicit Projects override without probing it", async () => {
    await expect(
      resolveProjectsDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: { LIGHTCODE_PROJECTS_PATH: "/work/company" },
        probeDirectory: async () => {
          throw new Error("the explicit override must not be probed here");
        },
      }),
    ).resolves.toBe("/work/company");
  });

  test("supports common Projects casing and a deterministic fallback", async () => {
    await expect(
      resolveProjectsDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: {},
        probeDirectory: async (candidate) =>
          candidate === "/home/lightcode/projects" ? "available" : "missing",
      }),
    ).resolves.toBe("/home/lightcode/projects");

    await expect(
      resolveProjectsDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: {},
        probeDirectory: async () => "missing",
      }),
    ).resolves.toBe("/home/lightcode/Projects");
  });

  test("keeps a permission-gated Projects candidate for an explicit open", async () => {
    await expect(
      resolveProjectsDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: {},
        probeDirectory: async (candidate) =>
          candidate === "/home/lightcode/Projects"
            ? "permission-denied"
            : "missing",
      }),
    ).resolves.toBe("/home/lightcode/Projects");
  });

  test("rejects an unsafe explicit Projects override", async () => {
    await expect(
      resolveProjectsDirectoryPath({
        platform: "linux",
        homeDirectory: "/home/lightcode",
        environment: { LIGHTCODE_PROJECTS_PATH: "relative/projects" },
      }),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
  });
});

describe("workspace browser routes", () => {
  test("lists all known locations as unprobed without running a resolver", async () => {
    let resolverCalls = 0;
    const failIfCalled = async () => {
      resolverCalls += 1;
      throw new Error("location discovery must remain lazy");
    };
    const app = createWorkspaceRoutes({
      enableDrives: false,
      resolveLocationPaths: {
        desktop: failIfCalled,
        home: failIfCalled,
        documents: failIfCalled,
        downloads: failIfCalled,
        projects: failIfCalled,
      },
    });
    const response = await app.request("/locations");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      locations: [
        {
          id: "desktop",
          name: "Desktop",
          kind: "known-folder",
          state: "unprobed",
          pathLabel: "Desktop",
        },
        {
          id: "home",
          name: "Home (broad access)",
          kind: "known-folder",
          state: "unprobed",
          pathLabel: "Home",
        },
        {
          id: "documents",
          name: "Documents",
          kind: "known-folder",
          state: "unprobed",
          pathLabel: "Documents",
        },
        {
          id: "downloads",
          name: "Downloads",
          kind: "known-folder",
          state: "unprobed",
          pathLabel: "Downloads",
        },
        {
          id: "projects",
          name: "Projects",
          kind: "known-folder",
          state: "unprobed",
          pathLabel: "Projects",
        },
      ],
    });
    expect(resolverCalls).toBe(0);
  });

  test("opens each known location through its own lazy opaque capability", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lightcode-locations-"));
    temporaryDirectories.push(parent);
    const ids = [
      "desktop",
      "home",
      "documents",
      "downloads",
      "projects",
    ] as const;
    const locationPaths = Object.fromEntries(
      ids.map((id) => [id, path.join(parent, id)]),
    ) as Record<(typeof ids)[number], string>;
    for (const id of ids) {
      await mkdir(locationPaths[id]);
      await mkdir(path.join(locationPaths[id], `${id}-only`));
    }
    const app = createWorkspaceRoutes({ locationPaths });

    for (const id of ids) {
      const openResponse = await app.request(
        "/browser/open",
        jsonRequest({ locationId: id }),
      );
      expect(openResponse.status).toBe(201);
      const opened = (await openResponse.json()) as {
        browserId: string;
        location: { id: string; state: string; pathLabel: string };
      };
      expect(opened.location).toMatchObject({
        id,
        state: "available",
        pathLabel: id === "home" ? "Home" : `${id[0].toUpperCase()}${id.slice(1)}`,
      });
      const entriesResponse = await app.request(
        `/browser/${opened.browserId}/entries`,
        jsonRequest({ segments: [] }),
      );
      expect(entriesResponse.status).toBe(200);
      const entries = (await entriesResponse.json()) as {
        entries: Array<{ name: string }>;
      };
      expect(entries.entries.map((entry) => entry.name)).toEqual([
        `${id}-only`,
      ]);
    }
  });

  test("keeps missing locations isolated from locations that can open", async () => {
    const { desktop } = await makeDesktop();
    const missingDocuments = path.join(desktop, "missing-documents");
    const app = createWorkspaceRoutes({
      locationPaths: { desktop, documents: missingDocuments },
    });

    const locationsResponse = await app.request("/locations");
    expect(locationsResponse.status).toBe(200);
    expect(await locationsResponse.json()).toMatchObject({
      locations: expect.arrayContaining([
        expect.objectContaining({ id: "documents", state: "unprobed" }),
      ]),
    });
    const missing = await app.request(
      "/browser/open",
      jsonRequest({ locationId: "documents" }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      code: "location_missing",
      retryable: false,
    });
    await expect(openDesktop(app)).resolves.toBeString();
  });

  test("rejects unknown location IDs at the schema boundary", async () => {
    const app = createWorkspaceRoutes();
    const response = await app.request(
      "/browser/open",
      jsonRequest({ locationId: "filesystem-root" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });

  test("rejects a known-folder symlink that resolves to the filesystem root", async () => {
    if (process.platform === "win32") {
      return;
    }
    const parent = await mkdtemp(path.join(tmpdir(), "lightcode-root-link-"));
    temporaryDirectories.push(parent);
    const linkedDesktop = path.join(parent, "Desktop");
    await symlink(path.parse(parent).root, linkedDesktop, "dir");
    const app = createWorkspaceRoutes({
      locationPaths: { desktop: linkedDesktop },
    });

    const response = await app.request(
      "/browser/open",
      jsonRequest({ locationId: "desktop" }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "workspace_unavailable",
      retryable: false,
    });
  });

  test("opens Desktop only on demand and reports a missing location", async () => {
    const missingDesktop = path.join(tmpdir(), crypto.randomUUID(), "Desktop");
    const app = createWorkspaceRoutes({ desktopPath: missingDesktop });
    const response = await app.request(
      "/browser/open",
      jsonRequest({ locationId: "desktop" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "location_missing",
      error: `No Desktop folder at ${missingDesktop}.`,
      retryable: false,
    });
  });

  test("names the path and override when the Projects folder is absent", async () => {
    const missingProjects = path.join(tmpdir(), crypto.randomUUID(), "Projects");
    const app = createWorkspaceRoutes({
      locationPaths: { projects: missingProjects },
    });
    const response = await app.request(
      "/browser/open",
      jsonRequest({ locationId: "projects" }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe("location_missing");
    expect(body.error).toContain(missingProjects);
    expect(body.error).toContain("LIGHTCODE_PROJECTS_PATH");
  });

  test("hides Windows system entries and legacy junctions unless asked", async () => {
    const { desktop } = await makeDesktop();
    await mkdir(path.join(desktop, "project"));
    await mkdir(path.join(desktop, "Recent"));
    await writeFile(path.join(desktop, "NTUSER.DAT"), "");
    await writeFile(path.join(desktop, "ntuser.dat.LOG1"), "");
    await writeFile(path.join(desktop, "desktop.ini"), "");
    await writeFile(path.join(desktop, "notes.txt"), "");
    const app = createWorkspaceRoutes({ desktopPath: desktop });
    const browserId = await openDesktop(app);

    const list = async (body: Record<string, unknown>) => {
      const response = await app.request(
        `/browser/${browserId}/entries`,
        jsonRequest(body),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        entries: Array<{ name: string }>;
      };
      return payload.entries.map((entry) => entry.name).sort();
    };

    const foldersOnly = await list({ directoriesOnly: true });
    expect(foldersOnly).toEqual(["Recent", "project"].sort());
    const withFiles = await list({});
    if (process.platform === "win32") {
      expect(withFiles).toEqual(["Recent", "notes.txt", "project"].sort());
    }
    const everything = await list({ includeHidden: true });
    expect(everything).toContain("desktop.ini");
    expect(everything).toContain("NTUSER.DAT");
  });

  test("lists one level with hidden filtering and opaque pagination", async () => {
    const { desktop } = await makeDesktop();
    await mkdir(path.join(desktop, "alpha"));
    await mkdir(path.join(desktop, "beta"));
    await writeFile(path.join(desktop, "notes.txt"), "hello", "utf8");
    await writeFile(path.join(desktop, ".secret"), "hidden", "utf8");
    const app = createWorkspaceRoutes({ desktopPath: desktop });
    const browserId = await openDesktop(app);

    const firstResponse = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({ segments: [], limit: 2 }),
    );
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      entries: Array<{ name: string; kind: string }>;
      nextCursor: string | null;
      truncated: boolean;
    };
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBeString();
    expect(first.nextCursor).not.toBe("2");
    expect(first.truncated).toBe(true);

    const secondResponse = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({
        segments: [],
        limit: 2,
        cursor: first.nextCursor,
      }),
    );
    expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json()) as {
      entries: Array<{ name: string; size: number | null }>;
      nextCursor: string | null;
      truncated: boolean;
    };
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.truncated).toBe(false);
    expect([...first.entries, ...second.entries]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "alpha", kind: "directory" }),
        expect.objectContaining({ name: "beta", kind: "directory" }),
        expect.objectContaining({ name: "notes.txt", size: 5 }),
      ]),
    );
  });

  test("rejects traversal-shaped path segments before filesystem access", async () => {
    const { desktop } = await makeDesktop();
    const app = createWorkspaceRoutes({ desktopPath: desktop });
    const browserId = await openDesktop(app);

    for (const segment of ["..", ".", "nested/escape", "nested\\escape", "\0"]) {
      const response = await app.request(
        `/browser/${browserId}/entries`,
        jsonRequest({ segments: [segment] }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
  });

  test("accepts ordinary directory names that merely begin with two dots", async () => {
    const { desktop } = await makeDesktop();
    await mkdir(path.join(desktop, "..project"));
    const app = createWorkspaceRoutes({ desktopPath: desktop });
    const browserId = await openDesktop(app);

    const response = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({ segments: ["..project"] }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      browserId,
      segments: ["..project"],
    });
  });

  test("binds opaque cursors to the browser, path, and hidden-file view", async () => {
    const { desktop } = await makeDesktop();
    await mkdir(path.join(desktop, "nested"));
    await writeFile(path.join(desktop, "one"), "1", "utf8");
    await writeFile(path.join(desktop, "two"), "2", "utf8");
    const app = createWorkspaceRoutes({ desktopPath: desktop });
    const browserId = await openDesktop(app);
    const firstResponse = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({ segments: [], limit: 1 }),
    );
    const first = (await firstResponse.json()) as { nextCursor: string };
    expect(first.nextCursor).toBeString();

    const tampered = `${first.nextCursor.slice(0, -1)}${
      first.nextCursor.endsWith("A") ? "B" : "A"
    }`;
    for (const body of [
      { segments: [], cursor: tampered, limit: 1 },
      { segments: ["nested"], cursor: first.nextCursor, limit: 1 },
      {
        segments: [],
        cursor: first.nextCursor,
        limit: 1,
        includeHidden: true,
      },
    ]) {
      const response = await app.request(
        `/browser/${browserId}/entries`,
        jsonRequest(body),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_cursor" });
    }

    const otherBrowserId = await openDesktop(app);
    const otherBrowser = await app.request(
      `/browser/${otherBrowserId}/entries`,
      jsonRequest({ segments: [], cursor: first.nextCursor, limit: 1 }),
    );
    expect(otherBrowser.status).toBe(400);
    expect(await otherBrowser.json()).toMatchObject({ code: "invalid_cursor" });

    await writeFile(path.join(desktop, "three"), "3", "utf8");
    const future = new Date(Date.now() + 5_000);
    await utimes(desktop, future, future);
    const stale = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({ segments: [], cursor: first.nextCursor, limit: 1 }),
    );
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ code: "invalid_cursor" });
  });

  test.skipIf(process.platform === "win32")(
    "labels symlinks and refuses internal, external, and broken traversal",
    async () => {
      const { desktop, parent } = await makeDesktop();
      const outside = path.join(parent, "outside");
      const inside = path.join(desktop, "inside");
      await mkdir(outside);
      await mkdir(inside);
      await symlink(inside, path.join(desktop, "inside-link"), "dir");
      await symlink(outside, path.join(desktop, "outside-link"), "dir");
      await symlink(
        path.join(parent, "missing"),
        path.join(desktop, "broken-link"),
        "dir",
      );
      const app = createWorkspaceRoutes({ desktopPath: desktop });
      const browserId = await openDesktop(app);

      const listedResponse = await app.request(
        `/browser/${browserId}/entries`,
        jsonRequest({ segments: [], limit: 20 }),
      );
      const listed = (await listedResponse.json()) as {
        entries: Array<{ name: string; symlinkState: string | null }>;
      };
      expect(listed.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "inside-link",
            symlinkState: "internal",
          }),
          expect.objectContaining({
            name: "outside-link",
            symlinkState: "external",
          }),
          expect.objectContaining({
            name: "broken-link",
            symlinkState: "broken",
          }),
        ]),
      );

      const expectations = [
        ["inside-link", 422, "workspace_symlink_not_traversable"],
        ["outside-link", 403, "workspace_symlink_escape"],
        ["broken-link", 422, "workspace_symlink_broken"],
      ] as const;
      for (const [name, status, code] of expectations) {
        const response = await app.request(
          `/browser/${browserId}/select`,
          jsonRequest({ segments: [name] }),
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "discards a listing when the directory is swapped after validation",
    async () => {
      const { desktop, parent } = await makeDesktop();
      await writeFile(path.join(desktop, "allowed.txt"), "allowed", "utf8");
      const outside = path.join(parent, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
      let swapped = false;
      const app = createWorkspaceRoutes({
        desktopPath: desktop,
        beforeDirectoryOperation: async ({ operation }) => {
          if (operation !== "list" || swapped) {
            return;
          }
          swapped = true;
          await rename(desktop, path.join(parent, "original-desktop"));
          await symlink(outside, desktop, "dir");
        },
      });
      const browserId = await openDesktop(app);

      const response = await app.request(
        `/browser/${browserId}/entries`,
        jsonRequest({ segments: [], limit: 20 }),
      );
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toMatchObject({ code: "workspace_replaced" });
      expect(JSON.stringify(body)).not.toContain("secret.txt");
    },
  );

  test("creates a canonical session only through an opaque workspace grant", async () => {
    const { desktop } = await makeDesktop();
    const project = path.join(desktop, "project");
    await mkdir(project);
    let capturedCwd: string | undefined;
    let capturedIdentity: { device: string; inode: string } | undefined;
    const sessionId = crypto.randomUUID();
    const app = createWorkspaceRoutes({
      desktopPath: desktop,
      createSession: async (input) => {
        capturedCwd = input?.cwd;
        capturedIdentity = input?.expectedWorkspaceIdentity;
        return { id: sessionId };
      },
    });
    const browserId = await openDesktop(app);
    const selectionResponse = await app.request(
      `/browser/${browserId}/select`,
      jsonRequest({ segments: ["project"] }),
    );
    expect(selectionResponse.status).toBe(201);
    const selection = (await selectionResponse.json()) as {
      workspace: { id: string; pathLabel: string };
    };
    expect(selection.workspace).not.toHaveProperty("root");
    expect(selection.workspace.pathLabel).toBe("Desktop/project");

    const sessionResponse = await app.request(
      `/${selection.workspace.id}/sessions`,
      jsonRequest({ mode: "plan" }),
    );
    expect(sessionResponse.status).toBe(201);
    expect(await sessionResponse.json()).toEqual({ id: sessionId });
    expect(capturedCwd).toBe(await realpath(project));
    expect(capturedIdentity?.device).toBeString();
    expect(capturedIdentity?.inode).toBeString();
  });

  test("uses the opened location name and label when selecting a workspace", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lightcode-documents-"));
    temporaryDirectories.push(parent);
    const documents = path.join(parent, "Documents");
    const client = path.join(documents, "client");
    await mkdir(client, { recursive: true });
    let capturedCwd: string | undefined;
    const sessionId = crypto.randomUUID();
    const app = createWorkspaceRoutes({
      locationPaths: { documents },
      locationPathLabels: { documents: "My Documents" },
      createSession: async (input) => {
        capturedCwd = input?.cwd;
        return { id: sessionId };
      },
    });
    const browserId = await openLocation(app, "documents");

    const rootSelectionResponse = await app.request(
      `/browser/${browserId}/select`,
      jsonRequest({ segments: [] }),
    );
    expect(rootSelectionResponse.status).toBe(201);
    expect(await rootSelectionResponse.json()).toMatchObject({
      workspace: { name: "Documents", pathLabel: "My Documents" },
    });

    const clientSelectionResponse = await app.request(
      `/browser/${browserId}/select`,
      jsonRequest({ segments: ["client"] }),
    );
    expect(clientSelectionResponse.status).toBe(201);
    const clientSelection = (await clientSelectionResponse.json()) as {
      workspace: { id: string; name: string; pathLabel: string };
    };
    expect(clientSelection.workspace).toMatchObject({
      name: "client",
      pathLabel: "My Documents/client",
    });
    const sessionResponse = await app.request(
      `/${clientSelection.workspace.id}/sessions`,
      jsonRequest({}),
    );
    expect(sessionResponse.status).toBe(201);
    expect(await sessionResponse.json()).toEqual({ id: sessionId });
    expect(capturedCwd).toBe(await realpath(client));
  });

  test.skipIf(process.platform === "win32")(
    "reports containment errors for the opened location instead of Desktop",
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "lightcode-home-"));
      temporaryDirectories.push(parent);
      const home = path.join(parent, "home");
      const outside = path.join(parent, "outside");
      await mkdir(home);
      await mkdir(outside);
      await symlink(outside, path.join(home, "escape"), "dir");
      const app = createWorkspaceRoutes({ locationPaths: { home } });
      const browserId = await openLocation(app, "home");

      const response = await app.request(
        `/browser/${browserId}/select`,
        jsonRequest({ segments: ["escape"] }),
      );
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: string; code: string };
      expect(body.code).toBe("workspace_symlink_escape");
      expect(body.error).toContain("allowed Home location");
      expect(body.error).not.toContain("Desktop");
    },
  );

  test("uses the opened location name when its browser capability expires", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lightcode-downloads-"));
    temporaryDirectories.push(parent);
    const downloads = path.join(parent, "Downloads");
    await mkdir(downloads);
    let clock = Date.now();
    const app = createWorkspaceRoutes({
      locationPaths: { downloads },
      browserCapabilityTtlMs: 10,
      now: () => clock,
    });
    const browserId = await openLocation(app, "downloads");
    clock += 10;

    const response = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({ segments: [] }),
    );
    expect(response.status).toBe(410);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("browser_capability_expired");
    expect(body.error).toContain("Open Downloads again");
    expect(body.error).not.toContain("Desktop");
  });

  test("expires browser capabilities and detects a replaced selected root", async () => {
    const { desktop, parent } = await makeDesktop();
    let clock = Date.now();
    const app = createWorkspaceRoutes({
      desktopPath: desktop,
      browserCapabilityTtlMs: 100,
      now: () => clock,
    });
    const browserId = await openDesktop(app);
    clock += 100;
    const expired = await app.request(
      `/browser/${browserId}/entries`,
      jsonRequest({ segments: [] }),
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({
      code: "browser_capability_expired",
    });

    clock -= 100;
    const replacementApp = createWorkspaceRoutes({ desktopPath: desktop });
    const replacementBrowserId = await openDesktop(replacementApp);
    await rename(desktop, path.join(parent, "old-desktop"));
    await mkdir(desktop);
    const replaced = await replacementApp.request(
      `/browser/${replacementBrowserId}/entries`,
      jsonRequest({ segments: [] }),
    );
    expect(replaced.status).toBe(409);
    expect(await replaced.json()).toMatchObject({ code: "workspace_replaced" });
  });

  test("bounds browser capabilities and workspace grants with oldest eviction", async () => {
    const { desktop } = await makeDesktop();
    const createdSessionId = crypto.randomUUID();
    const app = createWorkspaceRoutes({
      desktopPath: desktop,
      createSession: async () => ({ id: createdSessionId }),
    });
    const browserIds: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      browserIds.push(await openDesktop(app));
    }
    const evictedBrowser = await app.request(
      `/browser/${browserIds[0]}/entries`,
      jsonRequest({ segments: [] }),
    );
    expect(evictedBrowser.status).toBe(410);

    const activeBrowserId = browserIds.at(-1) as string;
    const workspaceIds: string[] = [];
    for (let index = 0; index < 257; index += 1) {
      const selected = await app.request(
        `/browser/${activeBrowserId}/select`,
        jsonRequest({ segments: [] }),
      );
      expect(selected.status).toBe(201);
      const body = (await selected.json()) as { workspace: { id: string } };
      workspaceIds.push(body.workspace.id);
    }
    const evictedGrant = await app.request(
      `/${workspaceIds[0]}/sessions`,
      jsonRequest({}),
    );
    expect(evictedGrant.status).toBe(404);
    expect(await evictedGrant.json()).toMatchObject({
      code: "workspace_grant_not_found",
    });

    const activeGrant = await app.request(
      `/${workspaceIds.at(-1)}/sessions`,
      jsonRequest({}),
    );
    expect(activeGrant.status).toBe(201);
    expect(await activeGrant.json()).toEqual({ id: createdSessionId });
  });
});
