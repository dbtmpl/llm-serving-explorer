import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

function attachErrorGuards(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });

  return { consoleErrors, pageErrors };
}

test.describe("BLIS LLM Inference Viz App Shell", () => {
  test("loads 01-single-request, renders GPU & KV canvas, and supports Play/Pause, Step, and Scrubber", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html");

    await expect(page.getByTestId("blis-metadata-badge")).toBeVisible();
    await expect(page.getByTestId("gpu-map-view")).toBeVisible();
    await expect(page.getByTestId("pod-card-instance_0")).toBeVisible();
    await expect(page.getByTestId("hbm-bar-instance_0")).toBeVisible();

    const canvasBox = await page.getByTestId("kv-canvas-instance_0").boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(canvasBox!.width).toBeGreaterThan(100);
    expect(canvasBox!.height).toBeGreaterThan(40);

    // Initially at 0.00 ms (events 0 and 1 are at t_us=0, so ev 2/149)
    await expect(page.getByTestId("time-readout")).toContainText("0.00 ms");
    await expect(page.getByTestId("event-counter")).toContainText("ev 2/149");

    // Step forward by 1 event -> ev 3/149, then step back -> ev 2/149
    await page.getByTestId("step-forward").click();
    await expect(page.getByTestId("event-counter")).toContainText("ev 3/149");
    await page.getByTestId("step-back").click();
    await expect(page.getByTestId("event-counter")).toContainText("ev 2/149");

    // Play & verify clock advances, then Pause
    const playBtn = page.getByTestId("play-toggle");
    await expect(playBtn).toHaveText("Play");
    await playBtn.click();
    await expect(playBtn).toHaveText("Pause");
    await page.waitForTimeout(250);
    await playBtn.click();
    await expect(playBtn).toHaveText("Play");

    const timeAfterPlay = await page.getByTestId("time-readout").innerText();
    expect(timeAfterPlay).not.toMatch(/^0\.00 ms/);

    // Scrub to end of scenario
    const scrubber = page.getByTestId("timeline-scrubber");
    const maxVal = await scrubber.getAttribute("max");
    expect(Number(maxVal)).toBeGreaterThan(0);
    await scrubber.fill(String(maxVal));
    await expect(page.getByTestId("event-counter")).toContainText("ev 149/149");

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("switches between GPU Map, Metrics (with interactive SVG seek), and Event Log views", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html");
    await expect(page.getByTestId("gpu-map-view")).toBeVisible();

    // Switch to Metrics
    await page.getByTestId("view-tab-metrics").click();
    await expect(page.getByTestId("metrics-view")).toBeVisible();
    await expect(page.getByTestId("metrics-chart-kv")).toBeVisible();
    await expect(page.getByTestId("metrics-chart-latency")).toBeVisible();
    await expect(page.getByTestId("metrics-chart-prefix")).toBeVisible();

    // Click near 80% along the KV chart SVG to seek
    const svg = page.getByTestId("metrics-chart-kv").locator("svg");
    const svgBox = await svg.boundingBox();
    expect(svgBox).not.toBeNull();
    await page.mouse.click(svgBox!.x + svgBox!.width * 0.8, svgBox!.y + svgBox!.height * 0.5);
    const timeText = await page.getByTestId("time-readout").innerText();
    expect(timeText).not.toMatch(/^0\.00 ms/);

    // Switch to Event Log
    await page.getByTestId("view-tab-event-log").click();
    await expect(page.getByTestId("event-log-view")).toBeVisible();

    const rows = page.getByTestId("event-log-row");
    expect(await rows.count()).toBeGreaterThan(5);

    // Filter by kv category
    await page.getByTestId("event-category-filter").selectOption("kv");
    const firstRowType = await rows.first().getAttribute("data-event-type");
    expect(firstRowType).toMatch(/^kv\./);

    // Expand JSON details of first visible row
    const firstExpandBtn = rows.first().locator("button");
    await firstExpandBtn.click();
    await expect(page.locator("tr.event-detail-row")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("switches scenarios (04-kv-eviction-preemption and 05-memory-tiers) and renders bookmarks & CPU offload", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html");
    await expect(page.getByTestId("gpu-map-view")).toBeVisible();

    // Switch to 04-kv-eviction-preemption
    await page.getByTestId("scenario-select").selectOption("04-kv-eviction-preemption");
    await expect(page.getByTestId("marker-first-eviction")).toBeVisible();
    await expect(page.getByTestId("marker-first-preemption")).toBeVisible();

    // Jump to first preemption bookmark and verify metrics reflect preemption
    await page.getByTestId("marker-first-preemption").click();
    await page.getByTestId("view-tab-metrics").click();
    await expect(page.getByTestId("kpi-preemptions")).toContainText(/[1-9]/);

    // Switch to 05-memory-tiers and verify CPU DRAM offload canvas renders in gpu-map
    await page.getByTestId("scenario-select").selectOption("05-memory-tiers");
    await page.getByTestId("view-tab-gpu-map").click();
    await expect(page.getByTestId("marker-first-kv-move")).toBeVisible();
    await expect(page.getByTestId("cpu-canvas-instance_0")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("restores scenario, timestamp, and view from URL query parameters on reload", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html?scenario=04-kv-eviction-preemption&t=1500000&view=metrics");

    await expect(page.getByTestId("metrics-view")).toBeVisible();
    await expect(page.getByTestId("scenario-select")).toHaveValue("04-kv-eviction-preemption");
    await expect(page.getByTestId("time-readout")).toContainText("1500.00 ms");

    // Reload and verify state persists
    await page.reload();
    await expect(page.getByTestId("metrics-view")).toBeVisible();
    await expect(page.getByTestId("scenario-select")).toHaveValue("04-kv-eviction-preemption");
    await expect(page.getByTestId("time-readout")).toContainText("1500.00 ms");

    // Open and close Glossary modal cleanly
    await page.getByTestId("glossary-toggle").click();
    await expect(page.getByRole("dialog", { name: "Inference Serving Glossary" })).toBeVisible();
    await page.getByTestId("close-glossary").click();
    await expect(page.getByRole("dialog", { name: "Inference Serving Glossary" })).toBeHidden();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("01-single-request renders Topology, Request Timeline, and GPU Map with source links", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html");

    // No view tabs should be marked pending
    await expect(page.locator(".view-tab.pending")).toHaveCount(0);

    // GPU Map has EvictionPreemptionStrip and SourceLinksChip
    await expect(page.getByTestId("gpu-map-view")).toBeVisible();
    await expect(page.getByTestId("eviction-preemption-strip")).toBeVisible();
    await expect(page.getByTestId("source-links-chip")).toBeVisible();

    // Topology view: Gateway + Pod + animated flow SVG
    await page.getByTestId("view-tab-topology").click();
    await expect(page.getByTestId("view-topology")).toBeVisible();
    await expect(page.getByTestId("topology-gateway-node")).toBeVisible();
    await expect(page.getByTestId("topology-pod-instance_0")).toBeVisible();
    await expect(page.getByRole("img", { name: "Cluster topology and request flow diagram" })).toBeVisible();
    await expect(page.getByTestId("source-links-chip")).toBeVisible();

    // Click pod in topology to inspect
    await page.getByTestId("topology-pod-instance_0").click();
    await expect(page.getByTestId("topology-inspector")).toContainText("instance_0");
    // Clear pod filter by clicking again
    await page.getByTestId("topology-pod-instance_0").click();

    // Scrub mid-run and switch to Request Timeline
    const scrubber = page.getByTestId("timeline-scrubber");
    const maxVal = await scrubber.getAttribute("max");
    await scrubber.fill(String(maxVal));

    await page.getByTestId("view-tab-request-timeline").click();
    await expect(page.getByTestId("view-request-timeline")).toBeVisible();
    await expect(page.getByRole("img", { name: "Request lifecycle phase waterfall Gantt chart" })).toBeVisible();
    await expect(page.locator('[data-testid^="timeline-row-"]')).toHaveCount(1);
    await expect(page.getByTestId("request-detail-card")).toBeVisible();
    await expect(page.getByTestId("request-detail-card")).toContainText("TTFT");
    await expect(page.getByTestId("request-detail-card")).toContainText("finished");
    await expect(page.getByTestId("source-links-chip")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("04-kv-eviction-preemption shows EvictionPreemptionStrip counts, jump buttons, and ledger in gpu-map", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html?scenario=04-kv-eviction-preemption&view=gpu-map");

    await expect(page.getByTestId("gpu-map-view")).toBeVisible();
    await expect(page.getByTestId("eviction-preemption-strip")).toBeVisible();

    // Scrub to end of run so evictions and preemptions are both > 0
    const scrubber = page.getByTestId("timeline-scrubber");
    const maxVal = await scrubber.getAttribute("max");
    await scrubber.fill(String(maxVal));

    const evictBadge = page.getByTestId("eviction-count-badge");
    const preemptBadge = page.getByTestId("preemption-count-badge");
    await expect(evictBadge).toContainText(/Evictions: [1-9]\d*/);
    await expect(preemptBadge).toContainText(/Preemptions: [1-9]\d*/);

    // Jump to last preemption and verify time readout updates away from end
    const endTime = await page.getByTestId("time-readout").innerText();
    await expect(page.getByTestId("jump-last-eviction")).toBeVisible();
    await expect(page.getByTestId("jump-last-preemption")).toBeVisible();
    await page.getByTestId("jump-last-preemption").click();
    const jumpedTime = await page.getByTestId("time-readout").innerText();
    expect(jumpedTime).not.toEqual(endTime);

    // Toggle expandable ledger
    await page.getByTestId("toggle-eviction-preemption-details").click();
    await expect(page.getByTestId("eviction-preemption-ledger")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("05-memory-tiers renders GPU HBM, CPU DRAM, Unmodelled SSD/S3 badges, and kv.block.moved ledger", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html?scenario=05-memory-tiers&view=tiers");

    await expect(page.getByTestId("view-tiers")).toBeVisible();
    await expect(page.getByTestId("tier-card-gpu-hbm")).toBeVisible();
    await expect(page.getByTestId("tier-card-cpu-dram")).toBeVisible();
    await expect(page.getByTestId("tier-card-local-ssd")).toContainText("Unmodelled in BLIS v0.32.0");
    await expect(page.getByTestId("tier-card-remote-store")).toContainText("Unmodelled in BLIS v0.32.0");
    await expect(page.getByTestId("source-links-chip")).toBeVisible();

    // Scrub to end of run to populate kv.block.moved ledger
    const scrubber = page.getByTestId("timeline-scrubber");
    const maxVal = await scrubber.getAttribute("max");
    await scrubber.fill(String(maxVal));

    await expect(page.getByTestId("tier-move-ledger")).toBeVisible();
    const moveRows = page.locator('[data-testid^="tier-move-row-"]');
    expect(await moveRows.count()).toBeGreaterThan(10);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("06-llmd-routing renders 4 candidate comparison bars and regret badge", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html?scenario=06-llmd-routing&view=routing-explained");

    await expect(page.getByTestId("view-routing-explained")).toBeVisible();
    await expect(page.getByTestId("source-links-chip")).toBeVisible();

    // Scrub to end to inspect routed decisions across 4 replicas
    const scrubber = page.getByTestId("timeline-scrubber");
    const maxVal = await scrubber.getAttribute("max");
    await scrubber.fill(String(maxVal));

    await expect(page.getByTestId("routing-inspector")).toBeVisible();
    await expect(page.locator('[data-testid^="candidate-bar-"]')).toHaveCount(4);
    await expect(page.getByTestId("routing-regret-badge")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("07-pd-disaggregation renders P/D Split pools + kv.transfer bars and Multi-GPU TP=2 ranks", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html?scenario=07-pd-disaggregation&view=pd-split");

    await expect(page.getByTestId("view-pd-split")).toBeVisible();
    await expect(page.getByTestId("source-links-chip")).toBeVisible();
    await expect(page.getByTestId("pd-prefill-column")).toBeVisible();
    await expect(page.getByTestId("pd-decode-column")).toBeVisible();
    await expect(page.locator('[data-testid^="pd-prefill-pod-"]')).toHaveCount(3);
    await expect(page.locator('[data-testid^="pd-decode-pod-"]')).toHaveCount(1);

    // Scrub to end to populate kv.transfer bars
    const scrubber = page.getByTestId("timeline-scrubber");
    const maxVal = await scrubber.getAttribute("max");
    await scrubber.fill(String(maxVal));

    await expect(page.getByTestId("pd-transfer-fabric")).toBeVisible();
    expect(await page.locator('[data-testid^="kv-transfer-"]').count()).toBeGreaterThan(0);

    // Switch to Multi-GPU view and verify TP=2 GPU rank cards & NVLink banner
    await page.getByTestId("view-tab-multi-gpu").click();
    await expect(page.getByTestId("view-multi-gpu")).toBeVisible();
    await expect(page.getByTestId("source-links-chip")).toBeVisible();
    await expect(page.getByTestId("multi-gpu-pod-instance_0")).toContainText("tp_degree=2");
    await expect(page.getByTestId("nvlink-banner-instance_0")).toBeVisible();
    // 4 pods * 2 GPU ranks each = 8 rank cards
    await expect(page.locator('[data-testid^="gpu-rank-card-"]')).toHaveCount(8);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("02-continuous-batching renders Roofline SVG ceilings, derived: true notice, and step points", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html?scenario=02-continuous-batching&view=roofline");

    await expect(page.getByTestId("view-roofline")).toBeVisible();
    await expect(page.getByTestId("source-links-chip")).toBeVisible();
    await expect(page.getByTestId("roofline-derived-notice")).toContainText("derived: true");

    // Scrub to end so prefill/decode/mixed points are plotted
    const scrubber = page.getByTestId("timeline-scrubber");
    const maxVal = await scrubber.getAttribute("max");
    await scrubber.fill(String(maxVal));

    const chart = page.getByTestId("roofline-pool-colocated-0");
    await expect(chart).toBeVisible();
    await expect(chart.locator("svg")).toContainText("BF16 Peak");
    await expect(chart.locator("svg")).toContainText("HBM BW");
    expect(await page.locator('[data-testid^="roofline-point-"]').count()).toBeGreaterThan(5);
    await expect(page.getByTestId("roofline-point-inspector")).toContainText("derived=true");

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("09-autoscaling Topology shows scaled pods, loading, draining, and terminated states across scrub", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);

    // At t=0, only 1 ready pod
    await page.goto("/classic.html?scenario=09-autoscaling&t=0&view=topology");
    await expect(page.getByTestId("view-topology")).toBeVisible();
    await expect(page.locator('[data-testid^="topology-pod-"]')).toHaveCount(1);
    await expect(page.getByTestId("topology-pod-instance_0")).toContainText("ready");

    // At t=2_000_000 (2000ms), 4 autoscaled pods created in loading state
    await page.goto("/classic.html?scenario=09-autoscaling&t=2000000&view=topology");
    await expect(page.locator('[data-testid^="topology-pod-"]')).toHaveCount(5);
    await expect(page.getByTestId("topology-pod-autoscale-llama-3.1-8b-instruct-000001")).toContainText("loading");

    // At t=5_000_000 (5000ms), scaled pods transition to draining
    await page.goto("/classic.html?scenario=09-autoscaling&t=5000000&view=topology");
    await expect(page.getByTestId("topology-pod-autoscale-llama-3.1-8b-instruct-000004")).toContainText("draining");

    // At t=6_000_000 (6000ms), pod 4 is terminated
    await page.goto("/classic.html?scenario=09-autoscaling&t=6000000&view=topology");
    await expect(page.getByTestId("topology-pod-autoscale-llama-3.1-8b-instruct-000004")).toContainText("terminated");

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("renders cleanly at narrow viewport (800px) without console or page errors", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto("/classic.html?scenario=07-pd-disaggregation&view=pd-split");

    await expect(page.getByTestId("view-pd-split")).toBeVisible();
    await page.getByTestId("view-tab-routing-explained").click();
    await expect(page.getByTestId("view-routing-explained")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("Compare mode compares 02-continuous-batching vs baseline with speedup badge and synced GPU KV maps", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html?scenario=02-continuous-batching");
    await expect(page.getByTestId("gpu-map-view")).toBeVisible();

    await page.getByTestId("mode-tab-compare").click();
    await expect(page.getByTestId("view-compare")).toBeVisible();
    await expect(page.getByTestId("compare-target-select")).toHaveValue("baseline");
    await expect(page.getByTestId("compare-delta-strip")).toBeVisible({ timeout: 15_000 });

    const speedBadgeText = await page.getByTestId("compare-final-badge-outputTokS").innerText();
    const ratioMatch = speedBadgeText.match(/(\d+(?:\.\d+)?)x/);
    expect(ratioMatch, `Expected speedup ratio badge in '${speedBadgeText}'`).not.toBeNull();
    expect(Number(ratioMatch![1])).toBeGreaterThan(2);

    // Switch synchronized view to GPU & KV Cache and confirm both panes render canvases
    await page.getByTestId("compare-panel-tab-gpu-map").click();
    const leftPane = page.getByTestId("compare-pane-left");
    const rightPane = page.getByTestId("compare-pane-right");
    await expect(leftPane.getByTestId("kv-canvas-instance_0")).toBeVisible();
    await expect(rightPane.getByTestId("kv-canvas-instance_0")).toBeVisible();

    // Scrubbing via PlaybackBar moves both panes in sync
    const initialLeftStatus = await page.getByTestId("compare-left-status").innerText();
    const initialRightStatus = await page.getByTestId("compare-right-status").innerText();
    const scrubber = page.getByTestId("timeline-scrubber");
    const maxVal = Number(await scrubber.getAttribute("max"));
    await scrubber.fill(String(Math.round(maxVal * 0.5)));

    await expect(page.getByTestId("compare-left-status")).not.toHaveText(initialLeftStatus);
    await expect(page.getByTestId("compare-right-status")).not.toHaveText(initialRightStatus);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("Custom Run executes real Browser WASM with single-request injection and jumps to Guided views", async ({
    page
  }) => {
    test.setTimeout(90_000);
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html");
    await expect(page.getByTestId("gpu-map-view")).toBeVisible();

    await page.getByTestId("mode-tab-custom").click();
    await expect(page.getByTestId("view-custom-run")).toBeVisible();

    const form = page.getByTestId("custom-run-form");
    await form.getByLabel("num_requests").fill("3");
    await form.getByLabel("rate (req/s)").fill("5");

    // Enable single-request injection
    await page.getByTestId("inject-toggle").check();
    const injectSection = page.getByTestId("inject-request-section");
    await injectSection.getByLabel("arrival_s (seconds)").fill("0.2");
    await injectSection.getByLabel("prompt_tokens").fill("128");
    await injectSection.getByLabel("output_tokens").fill("16");

    // Explicitly choose Browser WASM backend and run
    await page.getByTestId("backend-option-wasm").click();
    await page.getByTestId("custom-run-submit").click();

    await expect(page.getByTestId("custom-run-status")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("custom-run-status")).toContainText("backend: wasm");
    await expect(page.getByTestId("injected-req-pill")).toBeVisible();
    const pillText = await page.getByTestId("injected-req-pill").innerText();
    const injMatch = pillText.match(/request_\d+/);
    expect(injMatch, `Expected injected req ID in '${pillText}'`).not.toBeNull();
    const injectedReqId = injMatch![0];

    // Jump to Request Timeline and verify custom timeline + injected request focus
    await page.getByTestId("jump-request-timeline").click();
    await expect(page.getByTestId("custom-sim-banner")).toBeVisible();
    await expect(page.getByTestId("custom-sim-banner")).toContainText("Custom Simulation Active (wasm)");
    await expect(page.getByTestId("view-request-timeline")).toBeVisible();
    await expect(page.getByTestId(`timeline-row-${injectedReqId}`)).toBeVisible();

    // Switch to Topology and verify custom banner persists across guided views
    await page.getByTestId("view-tab-topology").click();
    await expect(page.getByTestId("view-topology")).toBeVisible();
    await expect(page.getByTestId("custom-sim-banner")).toBeVisible();

    // Return to preset scenario cleanly
    await page.getByTestId("back-to-preset-btn").click();
    await expect(page.getByTestId("custom-sim-banner")).toBeHidden();

    // Ignore benign local-runner health probe refusal if port 4190 is offline
    const unexpectedConsoleErrors = consoleErrors.filter(
      (msg) => !msg.includes("127.0.0.1:4190") && !msg.includes("ERR_CONNECTION_REFUSED")
    );
    expect(unexpectedConsoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("Accuracy page renders pinned BLIS stack versions, validation table, and unmodelled list", async ({
    page
  }) => {
    const { consoleErrors, pageErrors } = attachErrorGuards(page);
    await page.goto("/classic.html");
    await expect(page.getByTestId("gpu-map-view")).toBeVisible();

    await page.getByTestId("mode-tab-accuracy").click();
    await expect(page.getByTestId("view-accuracy")).toBeVisible();

    const accuracyView = page.getByTestId("view-accuracy");
    await expect(accuracyView).toContainText("0.32.0");
    await expect(accuracyView).toContainText("c79c7456");
    await expect(accuracyView).toContainText("v0.32.0-blis.3");
    await expect(accuracyView).toContainText("v1.0.0-blis.4");

    const valTable = page.getByTestId("accuracy-validation-table");
    await expect(valTable).toBeVisible();
    await expect(valTable).toContainText("PARTIAL");

    const unmodelledList = page.getByTestId("accuracy-unmodelled-list");
    await expect(unmodelledList).toBeVisible();
    await expect(unmodelledList).toContainText("Local NVMe/SSD");
    await expect(unmodelledList).toContainText("derived: true");

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("8-pod / 500-request stress run sustains >= 30 fps playback and < 200ms scrub jumps", async ({
    page
  }) => {
    test.setTimeout(90_000);
    const { consoleErrors, pageErrors } = attachErrorGuards(page);

    const fixtureGzPath = "/tmp/e2e-stress-8pod.ndjson.gz";
    if (!fs.existsSync(fixtureGzPath)) {
      const repoRoot = path.resolve(process.cwd(), "..");
      const blisBin = "/tmp/step3-verify/blis";
      if (!fs.existsSync(blisBin)) {
        execFileSync("go", ["build", "-o", blisBin, "."], {
          cwd: path.join(repoRoot, "engine"),
          stdio: "inherit"
        });
      }
      const ndjsonOut = "/tmp/e2e-stress-8pod.ndjson";
      execFileSync(
        blisBin,
        [
          "run",
          "--scenarios",
          path.join(repoRoot, "scenarios/06-llmd-routing"),
          "--scenario",
          "scenario.yaml",
          "--defaults-filepath",
          path.join(repoRoot, "engine/defaults.yaml"),
          "--num-instances",
          "8",
          "--num-requests",
          "500",
          "--rate",
          "80",
          "--prompt-tokens",
          "64",
          "--output-tokens",
          "16",
          "--prefix-tokens",
          "32",
          "--seed",
          "42",
          "--events-output",
          ndjsonOut
        ],
        { stdio: "ignore" }
      );
      const gz = execFileSync("gzip", ["-9", "-c", ndjsonOut]);
      fs.writeFileSync(fixtureGzPath, gz);
    }

    const stressGzBytes = fs.readFileSync(fixtureGzPath);
    const realManifestPath = path.resolve(process.cwd(), "../scenarios/manifest.json");
    const realManifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8")) as {
      schema_version: string;
      scenarios: Array<Record<string, unknown>>;
    };

    const augmentedManifest = {
      ...realManifest,
      scenarios: [
        ...realManifest.scenarios,
        {
          id: "stress-8pod",
          title: "Stress · 8 Pods / 500 Requests",
          subtitle: "Synthetic 8-pod 500-request performance fixture",
          events_file: "stress-8pod/events.ndjson.gz",
          recommended_views: ["topology", "gpu-map"],
          event_count: 65036,
          duration_us: 7_000_000,
          completed_requests: 500,
          events_bytes: stressGzBytes.byteLength
        }
      ]
    };

    await page.route("**/scenarios/manifest.json", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify(augmentedManifest)
      });
    });

    await page.route("**/scenarios/stress-8pod/events.ndjson.gz", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        body: stressGzBytes
      });
    });

    await page.route("**/scenarios/stress-8pod/narrative.md", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/markdown; charset=utf-8",
        body: "# Stress · 8 Pods / 500 Requests\n\nSynthetic 8-pod 500-request performance fixture."
      });
    });

    await page.route("**/scenarios/stress-8pod/flags.json", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: "{}"
      });
    });

    await page.goto("/classic.html?scenario=stress-8pod&view=topology");
    await expect(page.getByTestId("view-topology")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid^="topology-pod-"]')).toHaveCount(8, { timeout: 20_000 });

    const scrubber = page.getByTestId("timeline-scrubber");
    const maxUs = Number(await scrubber.getAttribute("max"));
    expect(maxUs).toBeGreaterThan(1_000_000);

    // Deterministic 10 random scrub jumps across [0.05..0.95] of timeline in Topology & GPU Map
    const fractions = [0.12, 0.78, 0.34, 0.91, 0.05, 0.63, 0.47, 0.85, 0.22, 0.56];

    const measureScrubs = async (label: string) => {
      const latenciesMs: number[] = [];
      for (const frac of fractions) {
        const targetUs = Math.round(maxUs * frac);
        const start = performance.now();
        await scrubber.fill(String(targetUs));
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        );
        const elapsed = performance.now() - start;
        latenciesMs.push(Number(elapsed.toFixed(2)));
        expect(
          elapsed,
          `${label} scrub jump to ${targetUs}us took ${elapsed.toFixed(2)}ms (>= 200ms)`
        ).toBeLessThan(200);
      }
      return latenciesMs;
    };

    const measurePlaybackFps = async (durationMs = 650) => {
      await scrubber.fill(String(Math.round(maxUs * 0.15)));
      await page.getByTestId("play-toggle").click();
      await expect(page.getByTestId("play-toggle")).toHaveText("Pause");

      const stats = await page.evaluate(
        (targetMs) =>
          new Promise<{ frames: number; elapsedMs: number; fps: number }>((resolve) => {
            let frames = 0;
            const start = performance.now();
            const step = (now: number) => {
              frames += 1;
              const elapsed = now - start;
              if (elapsed >= targetMs) {
                resolve({
                  frames,
                  elapsedMs: Number(elapsed.toFixed(2)),
                  fps: Number(((frames * 1000) / elapsed).toFixed(2))
                });
                return;
              }
              requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }),
        durationMs
      );

      await page.getByTestId("play-toggle").click();
      await expect(page.getByTestId("play-toggle")).toHaveText("Play");
      return stats;
    };

    const topologyScrubs = await measureScrubs("topology");
    const topologyFps = await measurePlaybackFps(650);
    expect(topologyFps.fps).toBeGreaterThanOrEqual(30);

    await page.getByTestId("view-tab-gpu-map").click();
    await expect(page.getByTestId("gpu-map-view")).toBeVisible();
    await expect(page.locator('[data-testid^="pod-card-"]')).toHaveCount(8);

    const gpuMapScrubs = await measureScrubs("gpu-map");
    const gpuMapFps = await measurePlaybackFps(650);
    expect(gpuMapFps.fps).toBeGreaterThanOrEqual(30);

    console.log(
      "[PERF 8-pod/500-req]",
      JSON.stringify({
        topologyFps,
        gpuMapFps,
        topologyScrubMaxMs: Math.max(...topologyScrubs),
        topologyScrubMeanMs: Number(
          (topologyScrubs.reduce((a, b) => a + b, 0) / topologyScrubs.length).toFixed(2)
        ),
        gpuMapScrubMaxMs: Math.max(...gpuMapScrubs),
        gpuMapScrubMeanMs: Number(
          (gpuMapScrubs.reduce((a, b) => a + b, 0) / gpuMapScrubs.length).toFixed(2)
        )
      })
    );

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
