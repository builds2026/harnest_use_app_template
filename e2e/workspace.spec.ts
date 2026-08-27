import { expect, test } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { demoState } from "../lib/demo";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const screenshotDirectory = "test-results/ui-audit/final-agent";

async function expectWorkspaceFitsViewport(page: import("playwright/test").Page, desktopRails: number) {
  const geometry = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace");
    const composer = document.querySelector<HTMLElement>(".composer-wrap");
    if (!workspace || !composer) throw new Error("Workspace geometry targets are missing");
    const composerRect = composer.getBoundingClientRect();
    const rails = [...document.querySelectorAll<HTMLElement>(".desktop-rail")]
      .filter((rail) => getComputedStyle(rail).display !== "none")
      .map((rail) => rail.getBoundingClientRect());
    return {
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      pageScrollWidth: document.documentElement.scrollWidth,
      workspaceClientWidth: workspace.clientWidth,
      workspaceScrollWidth: workspace.scrollWidth,
      composer: { left: composerRect.left, right: composerRect.right, top: composerRect.top, bottom: composerRect.bottom },
      rails: rails.map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
    };
  });
  expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.workspaceScrollWidth).toBeLessThanOrEqual(geometry.workspaceClientWidth);
  expect(geometry.composer.left).toBeGreaterThanOrEqual(0);
  expect(geometry.composer.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.composer.top).toBeGreaterThanOrEqual(0);
  expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.rails).toHaveLength(desktopRails);
  for (const rail of geometry.rails) {
    expect(rail.left).toBeGreaterThanOrEqual(0);
    expect(rail.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(rail.top).toBeGreaterThanOrEqual(0);
    expect(rail.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  }
}

test("auth, connection setup, one SSE, and per-turn files work together", async ({ page }) => {
  test.setTimeout(90_000);
  const connected = new Set<string>();
  const files: Array<Record<string, unknown>> = [];
  const memories: Array<Record<string, unknown>> = [];
  const pkmSources: Array<Record<string, unknown>> = [];
  const permissions: Array<Record<string, unknown>> = [{ id: id("30"), harnessId: "arc-reference", toolId: "search", capability: "web-search", resource: "example.test" }];
  const chatBodies: Array<{ fileIds?: string[] }> = [];
  const interactionCommands: Array<Record<string, unknown>> = [];
  let pendingInteraction: Record<string, unknown> | undefined;
  let runCancelled = false;
  let eventStreams = 0;
  let slowConversation: string | undefined;
  let releaseSlowConversation: (() => void) | undefined;
  let markSlowConversationStarted: (() => void) | undefined;
  let runStreamFailures = false;
  let runStreamRecovered = false;
  let recoveredStreamRequests = 0;
  let holdNextState = false;
  let releaseContextReload: (() => void) | undefined;
  let markContextReloadStarted: (() => void) | undefined;
  const contextReloadStarted = new Promise<void>((resolve) => { markContextReloadStarted = resolve; });
  const contextReloadRelease = new Promise<void>((resolve) => { releaseContextReload = resolve; });
  const slowConversationStarted = new Promise<void>((resolve) => { markSlowConversationStarted = resolve; });
  const slowConversationRelease = new Promise<void>((resolve) => { releaseSlowConversation = resolve; });

  const appState = (activeConversationId = id("2")) => {
    const missing = ["gemini-main", "search-main"].filter((name) => !connected.has(name));
    return {
      mode: "production", errors: [], user: { id: id("1"), email: "browser@example.test" },
      activeConversationId, conversations: [{ id: id("2"), title: "Browser smoke", preview: "", updatedAt: new Date().toISOString() }, { id: id("8"), title: "History target", preview: "Durable URL", updatedAt: new Date().toISOString() }],
      setup: { missing }, readiness: { ready: missing.length === 0, harnest: "ready", requiredConnections: ["gemini-main", "search-main", "sandbox-main"], missingConnections: missing },
      capabilities: [{ id: "conversation", label: "Conversation", kind: "capability", ready: missing.length === 0 }],
      messages: activeConversationId === id("8") ? [{ id: id("9"), role: "assistant", content: "History marker", createdAt: new Date().toISOString() }] : chatBodies.length ? [{ id: id("3"), role: "assistant", content: "SSE complete", createdAt: new Date().toISOString() }] : [],
      ...(pendingInteraction && activeConversationId === id("2") ? { activeRun: { id: id("7"), status: "paused", interactions: [pendingInteraction] } } : {}),
      files, artifacts: [], memories, pkmSources, citations: [], trace: [], permissions,
      connections: [...connected].map((name) => ({ name, kind: name === "gemini-main" ? "provider" : "api", status: "ready" })),
    };
  };

  await page.route("**/api/state**", async (route) => {
    const requested = new URL(route.request().url()).searchParams.get("conversation") ?? id("2");
    if (holdNextState) {
      holdNextState = false;
      markContextReloadStarted?.();
      await contextReloadRelease;
    }
    if (requested === slowConversation) {
      slowConversation = undefined;
      markSlowConversationStarted?.();
      await slowConversationRelease;
    }
    await route.fulfill({ json: appState(requested) }).catch(() => undefined);
  });
  await page.route("**/api/connections", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as { preset: "gemini" | "firecrawl"; secret: string };
    expect(body.secret).toBe("test-api-key-12345");
    const name = body.preset === "gemini" ? "gemini-main" : "search-main";
    connected.add(name);
    await route.fulfill({ json: { connection: { name, status: "ready", label: body.preset === "gemini" ? "Google AI Studio" : "Firecrawl" } } });
  });
  await page.route("**/api/files", async (route) => {
    const file = { id: id("4"), conversationId: id("2"), fileRef: "demo-file-ref", name: "note.txt", mimeType: "text/plain", size: 4, sha256: "a".repeat(64), status: "ready" };
    files.splice(0, files.length, file);
    await route.fulfill({ json: file });
  });
  await page.route("**/api/context", async (route) => {
    const body = route.request().postDataJSON() as { type: "memory" | "pkm"; id?: string; key?: string; value?: string; title?: string };
    if (route.request().method() === "DELETE") {
      if (body.type === "memory") memories.splice(memories.findIndex((item) => item.id === body.id), 1);
      else pkmSources.splice(pkmSources.findIndex((item) => item.id === body.id), 1);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (body.type === "memory") {
      memories.splice(0, memories.length, { id: id("31"), key: body.key, value: body.value, updatedAt: new Date().toISOString() });
      holdNextState = true;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    pkmSources.splice(0, pkmSources.length, { id: id("32"), title: body.title, kind: "owned", status: "ready" });
    await route.fulfill({ json: { ok: true, chunks: 1 } });
  });
  await page.route("**/api/permissions", async (route) => {
    const body = route.request().postDataJSON() as { id: string };
    permissions.splice(permissions.findIndex((item) => item.id === body.id), 1);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { fileIds?: string[] };
    chatBodies.push(body);
    if (chatBodies.length === 1) await route.fulfill({ status: 202, json: { runId: id("5"), conversationId: id("2"), status: "queued" } });
    else await route.fulfill({ status: 202, json: { runId: id("6"), conversationId: id("2"), status: "succeeded", output: "Second answer" } });
  });
  await page.route(`**/api/runs/${id("5")}/events`, async (route) => {
    eventStreams += 1;
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: [
      'id: 1\nevent: message\ndata: {"type":"delta","sequence":1,"text":"SSE "}\n\n',
      `event: message\ndata: {"type":"done","runId":"${id("5")}","conversationId":"${id("2")}","output":"SSE complete"}\n\n`,
    ].join("") });
  });
  await page.route(`**/api/runs/${id("7")}/events`, async (route) => {
    if (!runStreamFailures) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "retry: 10000\n\n" }).catch(() => undefined);
    }
    recoveredStreamRequests += 1;
    if (runStreamRecovered) return route.fulfill({ status: 200, contentType: "text/event-stream", body: `retry: 10000\nevent: message\ndata: {"type":"status","sequence":99,"phase":"running","label":"Recovered updates"}\n\n` });
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: "retry: 10\n\n" });
  });
  await page.route(`**/api/runs/${id("7")}/commands`, async (route) => {
    const body = route.request().postDataJSON() as { response?: Record<string, unknown>; cancel?: boolean };
    if (body.cancel) {
      runCancelled = true;
      pendingInteraction = undefined;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    expect(body.response).toBeDefined();
    interactionCommands.push(body.response!);
    pendingInteraction = undefined;
    await route.fulfill({ json: { ok: true } });
  });

  await page.goto("/login");
  await page.getByRole("tab", { name: "Sign up" }).click();
  await page.getByLabel("Email").fill(`browser-${Date.now()}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("Playwright-test-123!");
  await page.getByLabel("Confirm password").fill("Playwright-test-123!");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?conversation=${id("2")}$`, "u"), { timeout: 15_000 });

  await page.setViewportSize({ width: 1_024, height: 768 });
  await page.getByRole("button", { name: /Runtime setup is incomplete/u }).click();
  const contextDialog = page.getByRole("dialog", { name: "Workspace context" });
  await expect(contextDialog).toBeVisible();
  for (const service of ["Google AI Studio", "Firecrawl"]) {
    const card = contextDialog.locator(".connection-card").filter({ hasText: service });
    await card.getByLabel("API key").fill("test-api-key-12345");
    await card.getByRole("button", { name: "Connect and test" }).click();
    await expect(card.getByLabel("API key")).toHaveCount(0);
  }
  await contextDialog.getByRole("button", { name: "Close context panel" }).click();
  await page.setViewportSize({ width: 1_280, height: 768 });
  await page.getByRole("button", { name: "History target" }).click();
  await expect(page).toHaveURL(new RegExp(`conversation=${id("8")}$`, "u"));
  await expect(page.getByText("History marker", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`conversation=${id("2")}$`, "u"));
  await expect(page.getByRole("heading", { name: "Browser smoke" })).toBeVisible();
  await page.goForward();
  await expect(page.getByText("History marker", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("History marker", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Browser smoke" }).click();
  slowConversation = id("8");
  await page.getByRole("button", { name: "History target" }).click();
  await slowConversationStarted;
  await page.getByRole("button", { name: "Browser smoke" }).click();
  releaseSlowConversation?.();
  await expect(page).toHaveURL(new RegExp(`conversation=${id("2")}$`, "u"));
  await expect(page.getByText("History marker", { exact: true })).toHaveCount(0);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeEnabled();

  await page.getByRole("tab", { name: "Memory" }).click();
  await page.getByLabel("Key, e.g. writing.style").fill("style");
  await page.getByLabel("What should the harness remember?").fill("Keep responses concise.");
  await page.getByRole("button", { name: "Save memory" }).click();
  await contextReloadStarted;
  await expect(composer).toBeDisabled();
  releaseContextReload?.();
  await expect(composer).toBeEnabled();

  await expect(page.getByText("style", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Remove this memory?");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("style", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "PKM Sources" }).click();
  await page.getByLabel("Source title").fill("Launch notes");
  await page.getByLabel("Paste knowledge text to index").fill("Owned product context for retrieval.");
  await page.getByRole("button", { name: "Add knowledge" }).click();
  await expect(page.getByText("Launch notes", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Remove this knowledge source?");
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Launch notes", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "Permissions" }).click();
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Revoke this permission?");
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("search", { exact: true })).toHaveCount(0);

  await page.locator('input[type="file"]').setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("note") });
  await expect(page.getByText("note.txt").first()).toBeVisible();
  await composer.fill("First turn");
  await composer.press("Enter");
  await expect(page.getByText("SSE complete")).toBeVisible();
  expect(eventStreams).toBe(1);
  expect(chatBodies[0]?.fileIds).toEqual([id("4")]);

  await composer.fill("Second turn");
  await composer.press("Enter");
  await expect(page.getByText("Second answer")).toBeVisible();
  expect(chatBodies[1]?.fileIds).toEqual([]);

  for (const [label, permission] of [["Allow once", "allow_once"], ["For this run", "allow_for_run"], ["Always", "allow_always"], ["Deny", "deny"]] as const) {
    pendingInteraction = {
      id: id(String(40 + interactionCommands.length)), kind: "permission", title: "Tool approval required", message: "Review the exact scope before this run continues.",
      requester: { kind: "tool", id: "builtin.file" }, blocking: "run",
      checkpoint: { digest: "a".repeat(64), revision: 1, sequence: interactionCommands.length + 1 },
      data: { previewLimited: false, resourceResolved: true, risk: "write", input: { path: "work.txt", apiKey: "[REDACTED]" }, permission: { toolId: "builtin.file", action: "write", capability: "workspace-write", connectionId: "sandbox-main", resource: "work.txt" } },
    };
    await page.reload();
    await expect(page.getByRole("heading", { name: "Tool approval required" })).toBeVisible();
    await expect(page.getByText("builtin.file", { exact: false }).first()).toBeVisible();
    await expect(page.locator(".permission-preview")).toContainText("[REDACTED]");
    await expect(page.getByText("Only this exact tool call")).toBeVisible();
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(() => interactionCommands.at(-1)?.permission).toBe(permission);
  }

  pendingInteraction = {
    id: id("50"), kind: "input", title: "Choose retry count", message: "Enter a number from two through five.",
    checkpoint: { digest: "b".repeat(64), revision: 2, sequence: 5 }, schema: { type: "integer", minimum: 2, maximum: 5 },
  };
  await page.reload();
  const submit = page.getByRole("button", { name: "Submit", exact: true });
  const response = page.getByRole("spinbutton", { name: "Response" });
  await expect(submit).toBeDisabled();
  await response.fill("1");
  await expect(submit).toBeDisabled();
  await response.fill("3");
  await expect(submit).toBeEnabled();
  await response.press("Enter");
  await expect.poll(() => interactionCommands.at(-1)?.value).toBe(3);

  pendingInteraction = {
    id: id("51"), kind: "form", title: "Confirm deployment", message: "Complete the bounded form.",
    checkpoint: { digest: "c".repeat(64), revision: 3, sequence: 6 },
    schema: { type: "object", additionalProperties: false, required: ["environment", "replicas"], properties: { environment: { type: "string", title: "Environment", enum: ["staging", "production"] }, replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 3 } } },
  };
  await page.reload();
  await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Environment" }).click();
  await page.getByRole("option", { name: "staging" }).click();
  const replicas = page.getByLabel("Replicas");
  await replicas.fill("2");
  await replicas.press("Enter");
  await expect.poll(() => interactionCommands.at(-1)?.value).toEqual({ environment: "staging", replicas: 2 });

  pendingInteraction = {
    id: id("52"), kind: "input", title: "Expired request", message: "This request is stale.", expiresAt: new Date(Date.now() - 1_000).toISOString(),
    checkpoint: { digest: "d".repeat(64), revision: 4, sequence: 7 }, schema: { type: "string", minLength: 1 },
  };
  await page.reload();
  await expect(page.getByText("This request has expired.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit", exact: true })).toBeDisabled();
  await expect(page.getByText("More input required", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /New conversation/u })).toBeDisabled();
  await expect(page.getByText("Finish or cancel the active run before starting another conversation.", { exact: true })).toBeVisible();

  runStreamFailures = true;
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry updates" })).toBeVisible({ timeout: 15_000 });
  expect(recoveredStreamRequests).toBeGreaterThanOrEqual(3);
  runStreamRecovered = true;
  const requestsBeforeRetry = recoveredStreamRequests;
  await page.getByRole("button", { name: "Retry updates" }).click();
  await expect.poll(() => recoveredStreamRequests).toBeGreaterThan(requestsBeforeRetry);
  await expect(page.getByRole("button", { name: "Retry updates" })).toHaveCount(0);

  await page.setViewportSize({ width: 1_024, height: 768 });
  const openContext = page.getByRole("button", { name: "Open context panel" });
  await openContext.focus();
  await page.keyboard.press("Enter");
  const railDialog = page.getByRole("dialog", { name: "Workspace context" });
  await expect(railDialog).toBeVisible();
  await expect(railDialog.getByRole("button", { name: "Close context panel" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await railDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(railDialog).toHaveCount(0);
  await expect(openContext).toBeFocused();

  await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel run", exact: true }).click();
  await expect.poll(() => runCancelled).toBe(true);
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toHaveCount(0);

  const geometry = await page.locator(".workspace").evaluate((workspace) => ({ clientWidth: workspace.clientWidth, scrollWidth: workspace.scrollWidth }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

  await page.unroute("**/api/state**");
  await page.route("**/api/state**", (route) => route.fulfill({ json: demoState(new URL(route.request().url()).searchParams.get("conversation") ?? undefined) }));
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");
  await expect(page.getByText("Local deterministic development path", { exact: true })).toBeVisible();

  await mkdir(screenshotDirectory, { recursive: true });
  await page.setViewportSize({ width: 1_440, height: 900 });
  if (await page.locator("html").getAttribute("data-theme") === "dark") await page.getByRole("button", { name: "Use light theme" }).click();
  await expectWorkspaceFitsViewport(page, 2);
  await page.screenshot({ path: `${screenshotDirectory}/authenticated-demo-light-1440x900.png`, fullPage: true });
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectWorkspaceFitsViewport(page, 2);
  await page.screenshot({ path: `${screenshotDirectory}/authenticated-demo-dark-1440x900.png`, fullPage: true });
  await page.getByRole("button", { name: "Use light theme" }).click();
  await page.setViewportSize({ width: 1_024, height: 768 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expectWorkspaceFitsViewport(page, 0);
  await expect(page.locator(".rail-dialog")).toHaveCount(0);
  await page.screenshot({ path: `${screenshotDirectory}/authenticated-demo-light-1024x768.png`, fullPage: true });
  await page.setViewportSize({ width: 1_280, height: 800 });

  const demoComposer = page.getByRole("textbox", { name: "Message" });
  await demoComposer.fill("Summarize the contest evidence");
  await demoComposer.press("Enter");
  await expect(page.getByRole("button", { name: "Cancel run", exact: true })).toBeVisible();
  await expect(page.getByText(/Local deterministic result for/u)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Local deterministic result for/u)).toBeVisible();

  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.getByRole("link", { name: "Download product-notes.md" })).toHaveAttribute("href", "/api/files?id=f1");
  await expect(page.getByRole("link", { name: "Download interviews.pdf" })).toHaveCount(0);
  await page.getByLabel("Use product-notes.md in the next message").check();
  await expect(page.getByLabel("Files selected for the next message")).toContainText("product-notes.md");
  await page.getByRole("button", { name: "Remove product-notes.md from the next message" }).click();

  await page.getByRole("tab", { name: "Artifact" }).click();
  await expect(page.getByRole("heading", { name: "Q3 launch brief" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download q3-launch-brief.md" })).toHaveAttribute("href", "/api/artifacts?id=a1");

  await page.getByRole("tab", { name: "Memory" }).click();
  await page.getByLabel("Key, e.g. writing.style").fill("contest.format");
  await page.getByLabel("What should the harness remember?").fill("Show evidence before claims.");
  await page.getByRole("button", { name: "Save memory" }).click();
  await expect(page.getByText("contest.format", { exact: true })).toBeVisible();
  const contestMemory = page.locator(".memory-card").filter({ hasText: "contest.format" });
  await contestMemory.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("contest.format", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "PKM Sources" }).click();
  await page.getByLabel("Source title").fill("Contest evidence");
  await page.getByLabel("Paste knowledge text to index").fill("A deterministic, session-local source for the contest walkthrough.");
  await page.getByRole("button", { name: "Add knowledge" }).click();
  await expect(page.getByText("Contest evidence", { exact: true })).toBeVisible();
  const contestSource = page.locator(".item-card").filter({ hasText: "Contest evidence" });
  await contestSource.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Contest evidence", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "Citations" }).click();
  await expect(page.getByRole("link", { name: /Harnest product architecture/u })).toHaveAttribute("href", "https://example.com/harnest-architecture");
  await expect(page.locator(".citation-static").filter({ hasText: "Security boundary" })).toContainText("no external link");

  await page.getByRole("tab", { name: "Trace" }).click();
  await expect(page.locator(".trace-metadata").first()).toContainText("sequence=");
  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(page.getByText("file attachments", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Run interaction tour" }).click();
  await page.getByRole("combobox", { name: "Select response" }).click();
  await page.getByRole("option", { name: "Developers" }).click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.getByRole("combobox", { name: "Channel" }).click();
  await page.getByRole("option", { name: "Video" }).click();
  await page.getByRole("combobox", { name: "Security reviewed" }).click();
  await page.getByRole("option", { name: "Yes" }).click();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await page.getByLabel("Interaction file").setInputFiles({ name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("evidence") });
  await page.getByRole("button", { name: "Simulate session authorization" }).click();
  await expect(page.getByRole("heading", { name: "Demonstrate decline" })).toBeVisible();
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Demonstrate cancel" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const decision of ["Allow once", "For this run", "Always", "Deny"]) await page.getByRole("button", { name: decision, exact: true }).click();
  await expect(page.getByText("Interaction tour complete.", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Permissions" }).click();
  await expect(page.getByText("builtin.file", { exact: true })).toBeVisible();
  const demoGrant = page.locator(".item-card").filter({ hasText: "builtin.file" });
  await demoGrant.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("builtin.file", { exact: true })).toHaveCount(0);
});
