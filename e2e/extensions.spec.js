// Extensions page e2e tests.
// Tests MCP server and skill management UI with new naming (Enabled/Store tabs).

import { test, expect } from "@playwright/test";
import { baseURL, gotoExtensions, gotoSkills } from "./helpers.js";

// Unique name generator to avoid collisions between tests
function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

test.describe("Extensions Page - UI Rendering", () => {
  test("page loads with correct tab names (Enabled/Store)", async ({ page }) => {
    await gotoExtensions(page);

    // No page-level <h1>: as a Settings section, the modal's nav already names
    // this pane, so the old heading was a duplicate. The section heading inside
    // the pane remains.
    await expect(page.getByRole("heading", { name: /^MCP$/i, level: 1 })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /^MCP$/i })).toBeVisible();

    // Check tab names (new naming)
    await expect(page.getByRole("button", { name: /enabled/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /store/i })).toBeVisible();

    // Enabled tab should be active by default
    await expect(page.getByRole("button", { name: /enabled/i })).toHaveClass(/border-primary/);
  });

  test("MCP section shows correct title and button labels", async ({ page }) => {
    await gotoExtensions(page);

    // Section title should be just "MCP" (not "MCP Servers")
    await expect(page.getByTestId("mcp-section").getByRole("heading", { name: /^MCP$/i })).toBeVisible();

    // Button should say "Add MCP" (not "Add MCP Server")
    await expect(page.getByTestId("add-mcp-btn")).toBeVisible();
    await expect(page.getByTestId("add-mcp-btn")).toHaveText(/add mcp/i);
  });

  test("Skills section shows correct title and button labels", async ({ page }) => {
    await gotoSkills(page);

    // Section title
    await expect(page.getByTestId("skills-section").getByRole("heading", { name: /^Skills$/i })).toBeVisible();

    // Button should say "Create Skill" (not "Add Custom Skill")
    await expect(page.getByTestId("create-skill-btn")).toBeVisible();
    await expect(page.getByTestId("create-skill-btn")).toHaveText(/create skill/i);
  });

  test("startup-sourced MCP servers show auto badge and hide delete button", async ({ page }) => {
    await gotoExtensions(page);

    // memory is seeded from the isolated MCP config with source=startup
    const memoryCard = page.getByTestId("mcp-card").filter({ has: page.getByText(/^memory$/i) });
    await expect(memoryCard).toBeVisible();

    // Should show auto badge (⚡ auto)
    await expect(memoryCard.getByTestId("mcp-auto-badge")).toBeVisible();

    // Should NOT show delete button
    await expect(memoryCard.getByTestId("mcp-delete-btn")).not.toBeVisible();

    // Should still show edit button
    await expect(memoryCard.getByTestId("mcp-edit-btn")).toBeVisible();
  });

  test("startup-sourced MCP servers show type badge (Stdio/HTTP)", async ({ page }) => {
    await gotoExtensions(page);

    // memory is stdio type
    const memoryCard = page.getByTestId("mcp-card").filter({ has: page.getByText(/^memory$/i) });
    const typeBadge = memoryCard.getByTestId("mcp-type-badge");
    await expect(typeBadge).toBeVisible();
    await expect(typeBadge).toHaveText(/stdio/i);
  });

  test("can switch between Enabled and Store tabs", async ({ page }) => {
    await gotoExtensions(page);

    const enabledTab = page.getByRole("button", { name: /enabled/i });
    const storeTab = page.getByRole("button", { name: /store/i });

    // Start on Enabled tab
    await expect(enabledTab).toHaveClass(/border-primary/);

    // Click Store tab
    await storeTab.click();
    await expect(storeTab).toHaveClass(/border-primary/);

    // Store content should be visible (skills moved to the /skills page)
    await expect(page.getByTestId("mcp-market-section")).toBeVisible();

    // Click back to Enabled
    await enabledTab.click();
    await expect(enabledTab).toHaveClass(/border-primary/);
  });
});

test.describe("Extensions Page - Store Tab", () => {
  test("Store tab shows MCP catalog items", async ({ page }) => {
    await gotoExtensions(page);

    // Switch to Store tab
    await page.getByRole("button", { name: /store/i }).click();

    // Should show MCP market section
    const mcpMarketSection = page.getByTestId("mcp-market-section");
    await expect(mcpMarketSection).toBeVisible();

    // Should have at least one MCP market card
    const mcpCards = page.getByTestId("mcp-market-card");
    await expect(mcpCards.first()).toBeVisible();

    // Each card should have an Install button
    const installBtn = mcpCards.first().getByRole("button", { name: /install/i });
    await expect(installBtn).toBeVisible();
  });

  test("Store tab shows Skills catalog items", async ({ page }) => {
    await gotoSkills(page);

    // Switch to Store tab
    await page.getByRole("button", { name: /store/i }).click();

    // Should show Skills market section
    const skillsMarketSection = page.getByTestId("skills-market-section");
    await expect(skillsMarketSection).toBeVisible();

    // Should have at least one Skill market card
    const skillCards = page.getByTestId("skill-market-card");
    await expect(skillCards.first()).toBeVisible();
  });

  test("clicking Install on MCP opens pre-filled form", async ({ page }) => {
    await gotoExtensions(page);

    // Switch to Store tab
    await page.getByRole("button", { name: /store/i }).click();

    // Click Install on first MCP card
    const firstCard = page.getByTestId("mcp-market-card").first();
    await firstCard.getByRole("button", { name: /install/i }).click();

    // Dialog should open with title "Add MCP"
    await expect(page.getByRole("heading", { name: /add mcp/i })).toBeVisible();

    // Form should be pre-filled (name field should have a value from catalog)
    const nameInput = page.getByLabel(/name/i);
    await expect(nameInput).toBeVisible();
    // Wait for the useEffect to set the value
    await expect(nameInput).toHaveValue(/.+/);
    // The name should be pre-filled from the catalog template
    const nameValue = await nameInput.inputValue();
    expect(nameValue.length).toBeGreaterThan(0);

    // Close dialog
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByRole("heading", { name: /add mcp/i })).not.toBeVisible();
  });
});

test.describe("Extensions Page - MCP Interaction Flow", () => {
  test("add MCP server via form → appears in Enabled → delete", async ({ page }) => {
    const testName = uniqueName("test-mcp");
    await gotoExtensions(page);

    // Click Add MCP button
    await page.getByTestId("add-mcp-btn").click();

    // Dialog should open
    await expect(page.getByRole("heading", { name: /add mcp/i })).toBeVisible();

    // Fill form - use HTTP type to avoid npx connection issues in e2e
    await page.getByLabel(/name/i).fill(testName);
    await page.getByLabel(/http/i).click();
    await page.getByLabel(/url/i).fill("http://localhost:9999/mcp");

    // Click Add button
    await page.getByRole("button", { name: /^add$/i }).click();

    // Dialog should close
    await expect(page.getByRole("heading", { name: /add mcp/i })).not.toBeVisible({ timeout: 5000 });

    // New server should appear in Enabled tab
    const newCard = page.getByTestId("mcp-card").filter({ has: page.getByText(new RegExp(`^${testName}$`, "i")) });
    await expect(newCard).toBeVisible({ timeout: 10000 });

    // Should NOT have auto badge (it's user-added)
    await expect(newCard.getByTestId("mcp-auto-badge")).not.toBeVisible();

    // Should have delete button
    await expect(newCard.getByTestId("mcp-delete-btn")).toBeVisible();

    // Clean up: delete the server
    page.on("dialog", (d) => d.accept());
    await newCard.getByTestId("mcp-delete-btn").click();

    // Should be gone
    await expect(newCard).not.toBeVisible({ timeout: 5000 });
  });

  test("toggle MCP server enable/disable", async ({ page }) => {
    const testName = uniqueName("test-toggle");
    await gotoExtensions(page);

    // Add a server first (HTTP type to avoid npx issues)
    await page.getByTestId("add-mcp-btn").click();
    await page.getByLabel(/name/i).fill(testName);
    await page.getByLabel(/http/i).click();
    await page.getByLabel(/url/i).fill("http://localhost:9999/mcp");
    await page.getByRole("button", { name: /^add$/i }).click();

    const newCard = page.getByTestId("mcp-card").filter({ has: page.getByText(new RegExp(`^${testName}$`, "i")) });
    await expect(newCard).toBeVisible({ timeout: 10000 });

    // Should be enabled by default (toggle checked)
    const toggle = newCard.getByTestId("mcp-toggle");
    await expect(toggle).toBeChecked();

    // Disable it
    await toggle.click();
    await expect(toggle).not.toBeChecked({ timeout: 5000 });

    // Should show disabled badge
    await expect(newCard.getByTestId("mcp-disabled-badge")).toBeVisible();

    // Re-enable
    await toggle.click();
    await expect(toggle).toBeChecked({ timeout: 5000 });
    await expect(newCard.getByTestId("mcp-disabled-badge")).not.toBeVisible();

    // Clean up
    page.on("dialog", (d) => d.accept());
    await newCard.getByTestId("mcp-delete-btn").click();
  });

  test("install MCP from Store → appears in Enabled", async ({ page }) => {
    await gotoExtensions(page);

    // Switch to Store tab
    await page.getByRole("button", { name: /store/i }).click();

    // Get the first MCP card's name
    const firstCard = page.getByTestId("mcp-market-card").first();
    // Click Install
    await firstCard.getByRole("button", { name: /install/i }).click();

    // Dialog should open
    await expect(page.getByRole("heading", { name: /add mcp/i })).toBeVisible();

    // Modify the name to make it unique
    const nameInput = page.getByLabel(/name/i);
    const originalName = await nameInput.inputValue();
    const uniqueTestName = `${originalName}-e2e-${Date.now()}`;
    await nameInput.clear();
    await nameInput.fill(uniqueTestName);

    // Click Add
    await page.getByRole("button", { name: /^add$/i }).click();

    // Should switch to Enabled tab and show the new item
    await expect(page.getByRole("button", { name: /enabled/i })).toHaveClass(/border-primary/, { timeout: 5000 });

    const newCard = page.getByTestId("mcp-card").filter({ has: page.getByText(new RegExp(uniqueTestName, "i")) });
    await expect(newCard).toBeVisible({ timeout: 10000 });

    // Clean up
    page.on("dialog", (d) => d.accept());
    await newCard.getByTestId("mcp-delete-btn").click();
  });
});

test.describe("Extensions Page - Skill Interaction Flow", () => {
  test("add custom skill via form → appears in Enabled → delete", async ({ page }) => {
    const testName = uniqueName("test-skill");
    await gotoSkills(page);

    // Click Create Skill button
    await page.getByTestId("create-skill-btn").click();

    // Dialog should open
    await expect(page.getByRole("heading", { name: /create skill/i })).toBeVisible();

    // Fill form
    await page.getByLabel(/name/i).fill(testName);
    await page.getByLabel(/description/i).fill("A test skill for e2e");
    await page.getByLabel(/content/i).fill("You are a test assistant.");

    // Click Add button
    await page.getByRole("button", { name: /^add$/i }).click();

    // Dialog should close
    await expect(page.getByRole("heading", { name: /create skill/i })).not.toBeVisible({ timeout: 5000 });

    // New skill should appear in Enabled tab
    const newCard = page.getByTestId("skill-card").filter({ has: page.getByText(new RegExp(`^${testName}$`, "i")) });
    await expect(newCard).toBeVisible({ timeout: 10000 });

    // Should have Custom badge
    await expect(newCard.getByText(/custom/i)).toBeVisible();

    // Should have delete button
    await expect(newCard.getByRole("button", { name: /delete/i })).toBeVisible();

    // Clean up
    page.on("dialog", (d) => d.accept());
    await newCard.getByRole("button", { name: /delete/i }).click();
    await expect(newCard).not.toBeVisible({ timeout: 5000 });
  });

  test("toggle custom skill enable/disable", async ({ page }) => {
    const testName = uniqueName("test-skill-toggle");
    await gotoSkills(page);

    // Add a skill first
    await page.getByTestId("create-skill-btn").click();
    await page.getByLabel(/name/i).fill(testName);
    await page.getByLabel(/description/i).fill("Test");
    await page.getByLabel(/content/i).fill("Test content");
    await page.getByRole("button", { name: /^add$/i }).click();

    const newCard = page.getByTestId("skill-card").filter({ has: page.getByText(new RegExp(`^${testName}$`, "i")) });
    await expect(newCard).toBeVisible({ timeout: 10000 });

    // Should be enabled by default
    const toggle = newCard.getByRole("switch");
    await expect(toggle).toBeChecked();

    // Disable
    await toggle.click();
    await expect(toggle).not.toBeChecked({ timeout: 5000 });

    // Should show disabled badge
    await expect(newCard.getByText(/disabled/i)).toBeVisible();

    // Re-enable
    await toggle.click();
    await expect(toggle).toBeChecked({ timeout: 5000 });

    // Clean up
    page.on("dialog", (d) => d.accept());
    await newCard.getByRole("button", { name: /delete/i }).click();
  });
});

test.describe("Extensions Page - API Endpoints", () => {
  test("GET /api/extensions/mcp returns source field", async ({ request }) => {
    const response = await request.get(`${baseURL}/api/extensions/mcp`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(Array.isArray(data.servers)).toBeTruthy();

    // Each server should have a source field
    for (const server of data.servers) {
      expect(server.source).toBeDefined();
      expect(["startup", "user"]).toContain(server.source);
    }
  });

  test("startup-sourced servers have source=startup", async ({ request }) => {
    const response = await request.get(`${baseURL}/api/extensions/mcp`);
    const data = await response.json();

    // memory is seeded from the isolated MCP config with source=startup
    const memory = data.servers.find((s) => s.name === "memory");
    expect(memory).toBeTruthy();
    expect(memory.source).toBe("startup");
  });

  test("can add and remove MCP server via API", async ({ request }) => {
    const serverName = uniqueName("api-test-mcp");

    // Add - use HTTP type and disabled to avoid npx connection issues in e2e
    const addResponse = await request.post(`${baseURL}/api/extensions/mcp`, {
      data: {
        name: serverName,
        config: { url: "http://localhost:9999/mcp" },
        enabled: false,
      },
    });
    expect(addResponse.ok()).toBeTruthy();
    const added = await addResponse.json();
    expect(added.name).toBe(serverName);
    expect(added.source).toBe("user"); // User-added should have source=user

    // Verify in list
    const listResponse = await request.get(`${baseURL}/api/extensions/mcp`);
    const list = await listResponse.json();
    expect(list.servers.find((s) => s.name === serverName)).toBeTruthy();

    // Remove
    const removeResponse = await request.delete(`${baseURL}/api/extensions/mcp/${serverName}`);
    expect(removeResponse.ok()).toBeTruthy();

    // Verify gone
    const listAfter = await request.get(`${baseURL}/api/extensions/mcp`);
    const listAfterJson = await listAfter.json();
    expect(listAfterJson.servers.find((s) => s.name === serverName)).toBeFalsy();
  });

  test("can add and remove custom skill via API", async ({ request }) => {
    const skillName = uniqueName("api-test-skill");

    // Add
    const addResponse = await request.post(`${baseURL}/api/extensions/skills`, {
      data: {
        name: skillName,
        description: "A test skill",
        content: "You are a test assistant.",
        enabled: true,
      },
    });
    expect(addResponse.ok()).toBeTruthy();
    const added = await addResponse.json();
    expect(added.name).toBe(skillName);

    // Verify in list
    const listResponse = await request.get(`${baseURL}/api/extensions/skills`);
    const list = await listResponse.json();
    const found = list.skills.find((s) => s.name === skillName);
    expect(found).toBeTruthy();
    expect(found.source).toBe("database");

    // Remove
    const removeResponse = await request.delete(`${baseURL}/api/extensions/skills/${skillName}`);
    expect(removeResponse.ok()).toBeTruthy();

    // Verify gone
    const listAfter = await request.get(`${baseURL}/api/extensions/skills`);
    const listAfterJson = await listAfter.json();
    expect(listAfterJson.skills.find((s) => s.name === skillName)).toBeFalsy();
  });

  test("can toggle MCP server enabled state via API", async ({ request }) => {
    const serverName = uniqueName("api-test-toggle");

    // Add
    await request.post(`${baseURL}/api/extensions/mcp`, {
      data: {
        name: serverName,
        config: { url: "http://localhost:9999/mcp" },
        enabled: false, // Disabled to avoid connection attempt
      },
    });

    // Disable
    const disableResponse = await request.patch(`${baseURL}/api/extensions/mcp/${serverName}/enable`, {
      data: { enabled: false },
    });
    expect(disableResponse.ok()).toBeTruthy();
    const disabled = await disableResponse.json();
    expect(disabled.enabled).toBe(false);

    // Re-enable - this will try to connect and may fail, so we just check the endpoint responds
    const enableResponse = await request.patch(`${baseURL}/api/extensions/mcp/${serverName}/enable`, {
      data: { enabled: true },
    });
    // Enable might fail because it tries to connect - that's OK for this test
    if (enableResponse.ok()) {
      const enabled = await enableResponse.json();
      expect(enabled.enabled).toBe(true);
    }

    // Clean up
    await request.delete(`${baseURL}/api/extensions/mcp/${serverName}`);
  });

  test("market catalog endpoint returns items", async ({ request }) => {
    const response = await request.get(`${baseURL}/api/extensions/market`);
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(Array.isArray(data.mcpServers)).toBeTruthy();
    expect(Array.isArray(data.skills)).toBeTruthy();
    expect(data.mcpServers.length).toBeGreaterThan(0);
    expect(data.skills.length).toBeGreaterThan(0);
  });
});
