import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("interaction controls use Base UI form, field, and generic select semantics", async () => {
  const [workspace, ui] = await Promise.all([
    readFile(new URL("components/workspace.tsx", root), "utf8"),
    readFile(new URL("components/ui.tsx", root), "utf8"),
  ]);
  const interaction = workspace.slice(workspace.indexOf("function InteractionCard"), workspace.indexOf("function ArtifactPanel"));

  assert.match(interaction, /<BaseForm[\s\S]*onFormSubmit=/u);
  assert.match(interaction, /validationMode="onBlur"/u);
  assert.match(interaction, /<button type="submit"/u);
  assert.doesNotMatch(interaction, /<select\b/u);
  assert.match(ui, /function SelectControl<Value>/u);
  assert.match(ui, /<Select\.Root<Value>/u);
  assert.match(ui, /value=\{option\.value\}/u);
  assert.match(ui, /<Field\.Label/u);
  assert.match(ui, /<Field\.Error/u);
});

test("interaction validation keeps protocol types, limits, and terminal states", async () => {
  const workspace = await readFile(new URL("components/workspace.tsx", root), "utf8");
  const interaction = workspace.slice(workspace.indexOf("function InteractionCard"), workspace.indexOf("function ArtifactPanel"));

  for (const kind of ["select", "input", "form", "file", "oauth", "permission"]) assert.match(interaction, new RegExp(`kind === "${kind}"`, "u"));
  for (const constraint of ["required", "minimum", "maximum", "minLength", "maxLength"]) assert.match(interaction, new RegExp(constraint, "u"));
  assert.match(interaction, /options=\{field\.enum\.map\(\(option\) => \(\{ value: option/u);
  assert.match(interaction, /\{ value: true[\s\S]*\{ value: false/u);
  assert.match(interaction, /aria-busy=\{busy\}/u);
  assert.match(interaction, /disabled=\{busy \|\| expired/u);
  assert.doesNotMatch(interaction, /type="password"/u);
});
