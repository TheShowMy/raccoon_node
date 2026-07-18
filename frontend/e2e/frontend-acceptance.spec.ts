import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.getByLabel("消息编辑器")).toBeVisible();
}

async function pushRoute(page: Page, route: string) {
  await page.evaluate((nextRoute) => {
    history.pushState({}, "", nextRoute);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, route);
}

async function conversationNodeIds(page: Page) {
  return page.evaluate(async () => {
    const load = new Function(
      "return import('/src/store/domainStore.ts')",
    ) as () => Promise<{
      useDomainStore: {
        getState: () => {
          conversation: {
            nodes: Record<string, { id: string; kind: string }>;
          };
          runs: Record<string, { id: string }>;
        };
      };
    }>;
    const { useDomainStore } = await load();
    const state = useDomainStore.getState();
    return {
      nodes: Object.values(state.conversation.nodes).map(({ id, kind }) => ({
        id,
        kind,
      })),
      runIds: Object.keys(state.runs),
    };
  });
}

async function conversationSessionState(page: Page) {
  return page.evaluate(async () => {
    const load = new Function(
      "return import('/src/store/domainStore.ts')",
    ) as () => Promise<{
      useDomainStore: {
        getState: () => {
          activeConversationSessionId: string;
          conversationSessions: Record<string, { id: string }>;
          conversationGraphs: Record<
            string,
            { nodes: Record<string, { state: string }> }
          >;
          conversation: { nodes: Record<string, unknown> };
        };
      };
    }>;
    const state = (await load()).useDomainStore.getState();
    return {
      activeSessionId: state.activeConversationSessionId,
      sessionIds: Object.keys(state.conversationSessions),
      activeNodeCount: Object.keys(state.conversation.nodes).length,
      abortedBySession: Object.fromEntries(
        Object.entries(state.conversationGraphs).map(([id, graph]) => [
          id,
          Object.values(graph.nodes).filter((node) => node.state === "aborted")
            .length,
        ]),
      ),
    };
  });
}

test("全画布默认壳、键盘工作台与真实浏览器 axe", async ({ page }) => {
  await openApp(page);
  await expect(page.getByLabel("消息内容")).toHaveCSS("resize", "none");
  await expect(page.getByLabel(/工作台，按 Enter 打开/)).toHaveCount(6);
  await expect(page.getByLabel("演示控制台")).toHaveCount(0);
  await expect(
    page.locator(
      ".app-bar,.status-bar,.side-inspector,.MuiDialog-root,.MuiDrawer-root,.MuiSnackbar-root,[role='dialog']",
    ),
  ).toHaveCount(0);

  const trigger = page.getByLabel("文件工作台，按 Enter 打开");
  await trigger.focus();
  await trigger.press("Enter");
  await expect(page).toHaveURL(/\/canvas\/workbenches\/files$/);
  await expect(page.getByRole("region", { name: "文件工作台" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/$/);
  await expect(trigger).toBeFocused();

  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    ({ impact }) => impact === "critical" || impact === "serious",
  );
  expect(
    blocking.map(({ id, nodes }) => ({
      id,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
});

test("对话按真实边界等距，活跃节点锚到 50%/65%，手动浏览可暂停", async ({
  page,
}) => {
  await openApp(page);
  const composer = page.getByLabel("消息编辑器");
  await composer.getByLabel("消息内容").fill("这个项目是什么？");
  await composer.getByRole("button", { name: "发送" }).click();

  const activeChip = page
    .locator(
      ".conversation-graph .chat-node__chip[data-state='streaming'],.conversation-graph .chat-node__chip[data-state='running']",
    )
    .last();
  await expect(activeChip).toBeVisible();
  await page.waitForTimeout(260);

  const geometry = await page
    .locator(".conversation-graph")
    .evaluate((graph) => {
      const graphRect = graph.getBoundingClientRect();
      const chips = graph.querySelectorAll<HTMLElement>(
        ".chat-node__chip[data-state='streaming'],.chat-node__chip[data-state='running']",
      );
      const activeNode =
        chips[chips.length - 1]?.closest<HTMLElement>(".react-flow__node");
      if (!activeNode) throw new Error("没有活动对话节点");
      const activeRect = activeNode.getBoundingClientRect();
      const viewport = graph.querySelector<HTMLElement>(
        ".react-flow__viewport",
      );
      const scale = viewport
        ? new DOMMatrix(getComputedStyle(viewport).transform).a
        : 1;
      const visibleNodes = [
        ...graph.querySelectorAll<HTMLElement>(
          ".react-flow__node:not([data-id^='chat-action'])",
        ),
      ]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            getComputedStyle(element).visibility !== "hidden"
          );
        })
        .map((element) => ({
          id: element.dataset.id ?? "",
          rect: element.getBoundingClientRect(),
        }))
        .sort((a, b) => a.rect.top - b.rect.top);
      const gaps: number[] = [];
      for (let index = 1; index < visibleNodes.length; index += 1) {
        const previous = visibleNodes[index - 1].rect;
        const current = visibleNodes[index].rect;
        const horizontalOverlap =
          Math.min(previous.right, current.right) -
          Math.max(previous.left, current.left);
        if (horizontalOverlap > 0)
          gaps.push((current.top - previous.bottom) / scale);
      }
      return {
        xRatio:
          (activeRect.left + activeRect.width / 2 - graphRect.left) /
          graphRect.width,
        yRatio:
          (activeRect.top + activeRect.height / 2 - graphRect.top) /
          graphRect.height,
        gaps,
      };
    });
  expect(geometry.xRatio).toBeCloseTo(0.5, 1);
  expect(geometry.yRatio).toBeCloseTo(0.65, 1);
  expect(Math.abs(geometry.yRatio - 0.5)).toBeGreaterThan(0.1);
  await expect
    .poll(async () => {
      const current = await page
        .locator(".conversation-graph")
        .evaluate((graph) => {
          const viewport = graph.querySelector<HTMLElement>(
            ".react-flow__viewport",
          );
          const scale = viewport
            ? new DOMMatrix(getComputedStyle(viewport).transform).a
            : 1;
          const rects = [
            ...graph.querySelectorAll<HTMLElement>(
              ".react-flow__node:not([data-id^='chat-action'])",
            ),
          ]
            .map((element) => element.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .sort((left, right) => left.top - right.top);
          return rects.slice(1).some((rect, index) => {
            const previous = rects[index];
            const horizontalOverlap =
              Math.min(previous.right, rect.right) -
              Math.max(previous.left, rect.left);
            return (
              horizontalOverlap > 0 &&
              Math.abs((rect.top - previous.bottom) / scale - 48) < 1.5
            );
          });
        });
      return current;
    })
    .toBe(true);

  const pane = page.locator(".conversation-graph .react-flow__pane");
  const box = await pane.boundingBox();
  if (!box) throw new Error("对话画布不可见");
  await page.mouse.move(box.x + box.width * 0.82, box.y + box.height * 0.32);
  await page.mouse.wheel(0, -220);
  const latest = page.getByRole("button", { name: "↓ 回到最新" });
  await expect(latest).toBeVisible();
  await latest.click();
  await expect(latest).toHaveCount(0);
});

test("澄清、回答、规格、确认到 Run 保持同一节点链与深链", async ({ page }) => {
  await openApp(page);
  const composer = page.getByLabel("消息编辑器");
  await composer.getByLabel("消息内容").fill("请实现节点化验收功能");
  await composer.getByRole("button", { name: "发送" }).click();
  const clarification = page.getByLabel("澄清问题节点");
  await expect(clarification).toBeVisible({ timeout: 8_000 });
  await expect(page.getByLabel("消息编辑器")).toHaveCount(0);
  await expect(clarification.getByText("待回答")).toBeVisible();
  await expect
    .poll(async () =>
      clarification.evaluate((node) => {
        const graph = node.closest<HTMLElement>(".conversation-graph");
        if (!graph) throw new Error("缺少对话图");
        const graphRect = graph.getBoundingClientRect();
        const nodeRect = node.getBoundingClientRect();
        return {
          x:
            (nodeRect.left + nodeRect.width / 2 - graphRect.left) /
            graphRect.width,
          y:
            (nodeRect.top + nodeRect.height / 2 - graphRect.top) /
            graphRect.height,
        };
      }),
    )
    .toMatchObject({ x: expect.closeTo(0.5, 1), y: expect.closeTo(0.65, 1) });
  await clarification.getByRole("radio", { name: /两者都涉及/ }).click();
  await clarification.getByRole("button", { name: "确认回答" }).click();

  await expect
    .poll(async () =>
      (await conversationNodeIds(page)).nodes.map((node) => node.kind),
    )
    .toEqual(
      expect.arrayContaining([
        "clarification_answer",
        "requirement_spec",
        "requirement_confirmation",
      ]),
    );
  await expect(page.getByLabel("消息编辑器")).toHaveCount(0);
  const ids = await conversationNodeIds(page);
  for (const kind of [
    "clarification_answer",
    "requirement_spec",
    "requirement_confirmation",
  ]) {
    const target = ids.nodes.find((node) => node.kind === kind);
    if (!target) throw new Error(`缺少 ${kind}`);
    await pushRoute(page, `/canvas/chat/branches/b-main/nodes/${target.id}`);
    await expect(
      page.locator(
        `.conversation-graph .react-flow__node[data-id='${target.id}']`,
      ),
    ).toBeVisible();
  }

  const confirmation = page.getByLabel("需求确认节点");
  await confirmation.getByRole("button", { name: "确认并执行" }).click();
  await expect(page.getByLabel("消息编辑器")).toBeVisible();
  await expect
    .poll(async () => (await conversationNodeIds(page)).runIds.length)
    .toBeGreaterThan(0);
  const runId = (await conversationNodeIds(page)).runIds[0];
  await pushRoute(page, `/canvas/workbenches/delivery/runs/${runId}`);
  await expect(page.getByLabel(/Run 节点/)).toBeVisible();
  const delivery = page.getByLabel("需求交付子画布");
  await expect(delivery.getByLabel(/确定需求/)).toBeVisible();
  await expect(delivery.getByLabel("WorkPlan 节点")).toBeVisible({
    timeout: 8_000,
  });
  await expect(delivery.getByLabel(/需求规格节点/)).toHaveCount(0);
  await expect(delivery.getByLabel(/需求确认节点/)).toHaveCount(0);
  await expect(delivery.getByLabel(/工作项：/).first()).toBeInViewport();
});

test("取消澄清会释放分支输入权并恢复 Composer", async ({ page }) => {
  await openApp(page);
  const composer = page.getByLabel("消息编辑器");
  await composer.getByLabel("消息内容").fill("请实现可取消的开发需求");
  await composer.getByRole("button", { name: "开发" }).click();
  await composer.getByRole("button", { name: "发送" }).click();
  const clarification = page.getByLabel("澄清问题节点");
  await expect(clarification).toBeVisible({ timeout: 8_000 });
  await expect(page.getByLabel("消息编辑器")).toHaveCount(0);
  await clarification.getByRole("button", { name: "取消本次需求" }).click();
  await expect(
    clarification.getByText("已取消", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("消息编辑器")).toBeVisible();
});

test("右上角新建独立会话，活动响应经确认停止并保留旧图", async ({ page }) => {
  await openApp(page);
  const newSession = page.getByRole("button", { name: "＋ 新建会话" });
  await expect(newSession).toBeVisible();
  const initial = await conversationSessionState(page);

  await newSession.click();
  await expect
    .poll(async () => (await conversationSessionState(page)).activeSessionId)
    .not.toBe(initial.activeSessionId);
  const emptySession = await conversationSessionState(page);
  expect(emptySession.sessionIds).toHaveLength(2);
  expect(emptySession.activeNodeCount).toBe(0);
  await expect(page.getByLabel("消息编辑器")).toBeVisible();

  const composer = page.getByLabel("消息编辑器");
  await composer.getByLabel("消息内容").fill("这个草稿应留在旧会话");
  await newSession.click();
  const firstPrompt = page.getByLabel("会话操作确认:新建独立会话");
  await expect(firstPrompt).toBeVisible();
  await firstPrompt.getByRole("button", { name: "取消" }).click();
  await expect(composer.getByLabel("消息内容")).toHaveValue(
    "这个草稿应留在旧会话",
  );

  await composer
    .getByLabel("消息内容")
    .fill("请实现一个不会继承旧上下文的新会话功能");
  await composer.getByRole("button", { name: "开发" }).click();
  await composer.getByRole("button", { name: "发送" }).click();
  const activeResponse = page
    .locator(
      ".conversation-graph .chat-node__chip[data-state='streaming'],.conversation-graph .chat-node__chip[data-state='running']",
    )
    .last();
  await expect(activeResponse).toBeVisible();
  const oldSessionId = (await conversationSessionState(page)).activeSessionId;
  await newSession.click();
  const confirmation = page.getByLabel("会话操作确认:新建独立会话");
  await expect(confirmation).toBeVisible();
  await expect(activeResponse).toBeVisible();
  await confirmation.getByRole("button", { name: "确认执行" }).click();

  await expect
    .poll(async () => (await conversationSessionState(page)).activeSessionId)
    .not.toBe(oldSessionId);
  await expect
    .poll(
      async () =>
        (await conversationSessionState(page)).abortedBySession[oldSessionId],
    )
    .toBeGreaterThan(0);
  const final = await conversationSessionState(page);
  expect(final.sessionIds).toHaveLength(3);
  expect(final.activeNodeCount).toBe(0);
  expect(final.abortedBySession[oldSessionId]).toBeGreaterThan(0);
  await expect(page.getByLabel("消息编辑器")).toBeVisible();
  await expect(page.getByText(/历史会话/)).toHaveCount(0);
});

test("redact 确认链、真实图片选择与对话节点深链", async ({ page }) => {
  await openApp(page);
  const composer = page.getByLabel("消息编辑器");
  const fileInput = composer.locator("input[type=file]");
  await fileInput.setInputFiles({
    name: "diagram.png",
    mimeType: "image/png",
    buffer: Buffer.from("not-a-decoded-image"),
  });
  await expect(composer.getByText("diagram.png")).toBeVisible();
  await composer.getByRole("button", { name: "移除附件 diagram.png" }).click();
  await expect(composer.getByText("diagram.png")).toHaveCount(0);

  await composer.getByLabel("消息内容").fill("请解释一下？");
  await composer.getByRole("button", { name: "发送" }).click();
  await expect
    .poll(async () =>
      (await conversationNodeIds(page)).nodes.some(
        (node) => node.kind === "user_message",
      ),
    )
    .toBe(true);
  const ids = await conversationNodeIds(page);
  const user = ids.nodes.find((node) => node.kind === "user_message");
  if (!user) throw new Error("缺少用户消息节点");
  await pushRoute(page, `/canvas/chat/branches/b-main/nodes/${user.id}`);
  const userNode = page.locator(
    `.conversation-graph .react-flow__node[data-id='${user.id}']`,
  );
  await expect(userNode).toBeVisible();
  await userNode.getByRole("button", { name: "从这里分支" }).click();
  await expect(
    page.locator(".chat-toolbar__branch[data-active]"),
  ).toContainText("分支");
  await userNode.getByRole("button", { name: "删除" }).click();
  const confirmation = page.getByLabel(/危险操作确认:删除对话节点可见内容/);
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认执行" }).click();
  await expect(userNode.getByText("已删除")).toBeVisible();
  await expect(page.getByLabel(/操作结果:删除对话节点可见内容/)).toBeVisible();
});

test("普通工作台连续页、GrayDango 打开工作台与内部滚动恢复", async ({
  page,
}) => {
  await openApp(page);
  for (const workbench of ["files", "git", "terminal", "usage", "settings"]) {
    await page.goto(`/canvas/workbenches/${workbench}`);
    const body = page.locator(
      `[data-workbench='${workbench}'] .workbench-node__body`,
    );
    await expect(body).toBeVisible();
    await expect(body.locator(".react-flow")).toHaveCount(0);
    if (workbench !== "usage") {
      await expect(body.locator("[data-pane-id]").first()).toBeVisible();
    }
    await expect(body.locator(".workbench-panel")).toHaveCount(0);
  }

  await page.goto("/canvas/workbenches/delivery");
  await expect(
    page.locator(
      "[data-workbench='delivery'] .workbench-node__body .react-flow",
    ),
  ).toHaveCount(1);

  await page.goto("/canvas/workbenches/settings");
  await expect(
    page.getByRole("region", { name: "设置分类导航" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "通用设置" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "设置分类" }).getByRole("button"),
  ).toHaveCount(4);
  await page.getByRole("button", { name: "模型", exact: true }).first().click();
  await expect(page.getByLabel("模型配置", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Provider 列表" }),
  ).toBeVisible();
  await expect(page.getByLabel("凭据与模型")).toBeVisible();
  await expect(page.getByLabel("模型能力与角色")).toBeVisible();
  await page.getByRole("button", { name: "维护" }).first().click();
  await expect(page.getByRole("region", { name: "维护设置" })).toBeVisible();

  await page.goto("/canvas/workbenches/usage");
  await expect(page.getByLabel("Token 指标")).toBeVisible();
  const usageMetrics = page.locator(".usage-summary-metric");
  await expect(usageMetrics).toHaveCount(3);
  for (const metric of await usageMetrics.all()) {
    await expect(metric).toContainText("未缓存");
    await expect(metric).toContainText("缓存");
  }
  await expect(page.getByLabel("Token 指标")).not.toContainText("已知至少");
  await expect(page.getByLabel("Token 指标")).toContainText(/万|千万|亿/);
  await expect(page.getByLabel("最近 365 天每日 Token 点阵图")).toBeVisible();
  await expect(page.getByRole("table", { name: "模型消耗" })).toBeVisible();
  await expect(page.getByText("预算进度")).toHaveCount(0);
  await expect(page.getByText("Provider 凭据")).toHaveCount(0);
  const scrollbar = await page
    .locator(".usage-workbench")
    .evaluate((element) => ({
      width: getComputedStyle(element, "::-webkit-scrollbar").width,
      radius: getComputedStyle(element, "::-webkit-scrollbar-thumb")
        .borderRadius,
    }));
  expect(scrollbar).toEqual({ width: "12px", radius: "0px" });

  await page.goto("/canvas/workbenches/files");
  await page.addStyleTag({ content: ".ftree { max-height: 80px; }" });
  const tree = page.locator(".ftree");
  await expect(tree).toBeVisible();
  await expect(tree.getByRole("button")).toHaveCount(10);
  const scrollable = await tree.evaluate((element) => {
    element.scrollTop = Math.min(
      70,
      element.scrollHeight - element.clientHeight,
    );
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return element.scrollTop;
  });
  expect(scrollable).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await page.getByLabel("文件工作台，按 Enter 打开").press("Enter");
  await expect(page.locator(".ftree")).toBeVisible();
  await expect
    .poll(() => page.locator(".ftree").evaluate((el) => el.scrollTop))
    .toBe(scrollable);

  await page.evaluate(async () => {
    const load = new Function(
      "return import('/src/store/domainStore.ts')",
    ) as () => Promise<{
      useDomainStore: { setState: (state: unknown) => void };
    }>;
    const { useDomainStore } = await load();
    useDomainStore.setState({
      notifications: {
        "e2e-settings": {
          id: "e2e-settings",
          severity: "warning",
          message: "设置诊断需要查看。",
          source_workbench: "settings",
          source_node_id: "ignored-in-ordinary-workbench",
          lifecycle: "active",
          raised_at: new Date().toISOString(),
          acknowledged_at: null,
          resolved_at: null,
        },
      },
    });
  });
  const pet = page.getByLabel("GrayDango 项目助手");
  const bubble = pet.getByLabel("通知队列");
  await expect(bubble).toBeVisible();
  const sprite = pet.getByRole("img");
  const [petBefore, bubbleBefore, spriteBox] = await Promise.all([
    pet.boundingBox(),
    bubble.boundingBox(),
    sprite.boundingBox(),
  ]);
  if (!petBefore || !bubbleBefore || !spriteBox) {
    throw new Error("GrayDango 或通知气泡不可见");
  }
  await page.mouse.move(
    spriteBox.x + spriteBox.width / 2,
    spriteBox.y + spriteBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(spriteBox.x - 240, spriteBox.y - 180, { steps: 6 });
  await page.mouse.up();
  const [petAfter, bubbleAfter] = await Promise.all([
    pet.boundingBox(),
    bubble.boundingBox(),
  ]);
  if (!petAfter || !bubbleAfter) throw new Error("拖动后气泡不可见");
  expect(petAfter.x - petBefore.x).not.toBeCloseTo(0, 0);
  expect(bubbleAfter.x - bubbleBefore.x).toBeCloseTo(
    petAfter.x - petBefore.x,
    0,
  );
  expect(bubbleAfter.y - bubbleBefore.y).toBeCloseTo(
    petAfter.y - petBefore.y,
    0,
  );
  await page.getByRole("button", { name: "定位" }).click();
  await expect(page).toHaveURL(/\/canvas\/workbenches\/settings$/);
  await expect(page.getByRole("region", { name: "通用设置" })).toBeVisible();
  await expect(
    page.locator(
      "[data-workbench='settings'] .workbench-node__body .react-flow",
    ),
  ).toHaveCount(0);
});

test("Git 连续三栏保留 2px/1px 间距并在窄屏切换 Diff", async ({ page }) => {
  await openApp(page);
  await page.goto("/canvas/workbenches/git");
  const workbench = page.locator("[data-workbench='git'] .tool-workbench");
  const panes = workbench.locator("[data-pane-id]");
  await expect(panes).toHaveCount(3);
  await expect(
    workbench.locator(".workbench-panel,.workbench-grid"),
  ).toHaveCount(0);
  const desktop = await workbench.evaluate((element) => {
    const paneRects = [
      ...element.querySelectorAll<HTMLElement>("[data-pane-id]"),
    ].map((pane) => pane.getBoundingClientRect());
    return {
      gap: getComputedStyle(element).getPropertyValue("--tool-pane-gap").trim(),
      gaps: paneRects
        .slice(1)
        .map((rect, index) => rect.left - paneRects[index].right),
    };
  });
  expect(desktop.gap).toBe("2px");
  expect(desktop.gaps.every((gap) => Math.abs(gap - 2) < 0.5)).toBe(true);

  const rows = workbench.locator(".git-change-row");
  await expect(rows).toHaveCount(16);
  const comfortableHeights = await rows.evaluateAll((elements) =>
    elements
      .slice(0, 12)
      .map((element) => element.getBoundingClientRect().height),
  );
  expect(comfortableHeights.every((height) => height <= 27)).toBe(true);

  const panesBeforeDock = await panes.evaluateAll((elements) =>
    elements.map((element) => ({
      left: (element as HTMLElement).offsetLeft,
      top: (element as HTMLElement).offsetTop,
      width: (element as HTMLElement).offsetWidth,
      height: (element as HTMLElement).offsetHeight,
    })),
  );
  const firstDiscard = workbench.getByRole("button", { name: /丢弃 / }).first();
  await firstDiscard.locator("xpath=ancestor::li").hover();
  await firstDiscard.click();
  const dock = workbench.getByLabel(/危险操作确认:丢弃/);
  await expect(dock).toBeVisible();
  const panesWithDock = await panes.evaluateAll((elements) =>
    elements.map((element) => ({
      left: (element as HTMLElement).offsetLeft,
      top: (element as HTMLElement).offsetTop,
      width: (element as HTMLElement).offsetWidth,
      height: (element as HTMLElement).offsetHeight,
    })),
  );
  expect(panesWithDock).toEqual(panesBeforeDock);
  await dock.getByRole("button", { name: "取消" }).click();
  await expect(workbench.getByLabel(/操作结果:丢弃/)).toBeVisible();

  await page.evaluate(async () => {
    const load = new Function(
      "return import('/src/store/appearanceStore.ts')",
    ) as () => Promise<{
      useAppearanceStore: {
        getState: () => { setDensity: (density: "compact") => void };
      };
    }>;
    const { useAppearanceStore } = await load();
    useAppearanceStore.getState().setDensity("compact");
  });
  await expect
    .poll(() =>
      workbench.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--tool-pane-gap").trim(),
      ),
    )
    .toBe("1px");
  const compactHeights = await rows.evaluateAll((elements) =>
    elements
      .slice(0, 12)
      .map((element) => element.getBoundingClientRect().height),
  );
  expect(compactHeights.every((height) => height <= 23)).toBe(true);

  await page.setViewportSize({ width: 780, height: 700 });
  const compactTabs = workbench.getByRole("tablist", {
    name: "Git 工作区分区",
  });
  await expect(compactTabs).toBeVisible();
  await expect(workbench.locator("[data-pane-id]:visible")).toHaveCount(1);
  await compactTabs.getByRole("tab", { name: /变更 16/ }).click();
  await page
    .getByRole("button", {
      name: "查看 frontend/src/canvas/nodes.tsx 的 Diff",
    })
    .click();
  await expect(compactTabs.getByRole("tab", { name: "Diff" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".git-diff-content__path")).toContainText(
    "frontend/src/canvas/nodes.tsx",
  );
});

test("终端只挂载当前 xterm，关闭确认使用底部悬浮 Dock", async ({ page }) => {
  await openApp(page);
  await page.goto("/canvas/workbenches/terminal");
  const workbench = page.locator("[data-workbench='terminal']");
  await workbench.getByRole("button", { name: "新建会话" }).click();
  await expect(workbench.locator(".terminal-tabs [role='tab']")).toHaveCount(1);
  await expect(workbench.locator(".term-pane")).toHaveCount(1);
  await workbench.getByRole("button", { name: "新建会话" }).click();
  await expect(workbench.locator(".terminal-tabs [role='tab']")).toHaveCount(2);
  await expect(workbench.locator(".term-pane")).toHaveCount(1);
  await workbench.getByRole("button", { name: "关闭", exact: true }).click();
  const confirmation =
    workbench.getByLabel(/危险操作确认:关闭运行中的终端会话/);
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认执行" }).click();
  await expect(workbench.locator(".terminal-tabs [role='tab']")).toHaveCount(1);
  await expect(
    workbench.getByLabel(/操作结果:关闭运行中的终端会话/),
  ).toBeVisible();
});

test("一万个对话节点保持有界 DOM，并可深链末端", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    const loadDomain = new Function(
      "return import('/src/store/domainStore.ts')",
    ) as () => Promise<{
      useDomainStore: { setState: (state: unknown) => void };
    }>;
    const loadDag = new Function(
      "return import('/src/chat/dag.ts')",
    ) as () => Promise<{
      createGraphState: (
        graph: string,
        branch: string,
      ) => Record<string, unknown>;
    }>;
    const [{ useDomainStore }, { createGraphState }] = await Promise.all([
      loadDomain(),
      loadDag(),
    ]);
    const nodes: Record<string, unknown> = {};
    const positions: Record<string, { x: number; y: number }> = {};
    for (let index = 0; index < 10_000; index += 1) {
      const id = `large-${index}`;
      nodes[id] = {
        id,
        graph_id: "g-main",
        kind: index % 2 === 0 ? "user_message" : "assistant_answer",
        state: "completed",
        content: `节点 ${index}`,
        node_sequence: 0,
        intent: null,
        parent_ids: index === 0 ? [] : [`large-${index - 1}`],
        branch_ids: ["b-main"],
        created_at: new Date(1_700_000_000_000 + index).toISOString(),
        completed_at: "2026-07-17T00:00:00Z",
        requirement_id: null,
        requirement_revision: null,
        clarification_round_id: null,
        redacted_at: null,
        tool_activity: null,
      };
      positions[id] = { x: 0, y: index };
    }
    const conversation = {
      ...createGraphState("g-main", "b-main"),
      nodes,
      positions,
      branches: {
        "b-main": {
          id: "b-main",
          graph_id: "g-main",
          anchor_node_id: null,
          parent_branch_id: null,
          created_at: "2026-07-17T00:00:00Z",
        },
      },
      heads: { "b-main": "large-9999" },
    };
    useDomainStore.setState({ conversation });
  });
  await pushRoute(page, "/canvas/chat/branches/b-main/nodes/large-9999");
  await expect(
    page.locator(".conversation-graph .react-flow__node[data-id='large-9999']"),
  ).toBeVisible({ timeout: 12_000 });
  const domCount = await page
    .locator(".conversation-graph .react-flow__node")
    .count();
  expect(domCount).toBeLessThan(100);
});
