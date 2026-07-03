/**
 * @file i18n.test.ts
 * @description Unit tests for i18n translation resources to ensure correct translations and locale handling in the agent dashboard application.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { describe, it, expect } from "vitest";
import i18n from "i18next";

describe("i18n resources", () => {
  it("should provide Turkish translations for navigation keys", async () => {
    await i18n.changeLanguage("tr");

    expect(i18n.t("nav:dashboard")).toBe("Gösterge Paneli");
    expect(i18n.t("nav:agentBoard")).toBe("Kanban Panosu");
    expect(i18n.t("nav:languageShort.tr")).toBe("TR");
  });

  it("should keep Agent terminology untranslated in zh and tr locales", async () => {
    await i18n.changeLanguage("zh");
    expect(i18n.t("common:agent")).toBe("Agent");
    expect(i18n.t("common:subagent")).toBe("Subagent");

    await i18n.changeLanguage("tr");
    expect(i18n.t("common:agent")).toBe("Agent");
    expect(i18n.t("common:subagent")).toBe("Subagent");
  });

  it("should support non-explicit Turkish locale tags", async () => {
    await i18n.changeLanguage("tr-TR");

    expect(i18n.resolvedLanguage?.startsWith("tr")).toBe(true);
    expect(i18n.t("nav:dashboard")).toBe("Gösterge Paneli");
  });

  it("pluralizes the subagent count labels in English", async () => {
    await i18n.changeLanguage("en");
    // The collapsed agent-tree badge (Dashboard) and SessionDetail both render
    // this key with a count. It MUST use i18next plural forms (_one/_other) so
    // "2 subagent" never shows — the flat common:subagent word is not a plural
    // key and rendering it with a count is the bug this guards against.
    expect(i18n.t("common:subagent_label", { count: 1 })).toBe("1 subagent");
    expect(i18n.t("common:subagent_label", { count: 2 })).toBe("2 subagents");
    // The main-agent card subtitle carries its own kanban plural key.
    expect(i18n.t("kanban:session.subagentSummary", { count: 1 })).toBe("1 subagent");
    expect(i18n.t("kanban:session.subagentSummary", { count: 3 })).toBe("3 subagents");
  });
});
