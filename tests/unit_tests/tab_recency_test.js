import "./test_helper.js";
import { TabRecency } from "../../background_scripts/tab_recency.js";

context("TabRecency", () => {
  let tabRecency;

  setup(() => tabRecency = new TabRecency());

  context("order", () => {
    setup(async () => {
      stub(chrome.tabs, "query", () => Promise.resolve([]));
      await tabRecency.init();
      tabRecency.queueAction("register", 1);
      tabRecency.queueAction("register", 2);
      tabRecency.queueAction("register", 3);
      tabRecency.queueAction("register", 4);
      tabRecency.queueAction("deregister", 4);
      tabRecency.queueAction("register", 2);
    });

    should("have the correct entries in the correct order", () => {
      const expected = [2, 3, 1];
      assert.equal(expected, tabRecency.getTabsByRecency());
    });

    should("score tabs by recency; current tab should be last", () => {
      const score = (id) => tabRecency.recencyScore(id);
      assert.equal(0, score(2));
      assert.isTrue(score(2) < score(1));
      assert.isTrue(score(1) < score(3));
    });
  });

  should("navigate actions are queued until state from storage is loaded", async () => {
    let onActivated;
    stub(chrome.tabs.onActivated, "addListener", (fn) => {
      onActivated = fn;
    });
    let resolveStorage;
    const storagePromise = new Promise((resolve, _) => resolveStorage = resolve);
    stub(chrome.storage.session, "get", () => storagePromise);
    tabRecency.init();
    // Here, chrome.tabs.onActivated listeners have been added by tabrecency, but the
    // chrome.storage.session data hasn't yet loaded.
    onActivated({ tabId: 5 });
    resolveStorage({});
    await tabRecency.init();
    assert.equal([5], tabRecency.getTabsByRecency());
  });

  should("loadFromStorage handles empty values", async () => {
    stub(chrome.tabs, "query", () => Promise.resolve([{ id: 1 }]));

    stub(chrome.storage.session, "get", () => Promise.resolve({}));
    await tabRecency.init();
    assert.equal([], tabRecency.getTabsByRecency());

    stub(chrome.storage.session, "get", () => Promise.resolve({ tabRecency: {} }));
    await tabRecency.loadFromStorage();
    assert.equal([], tabRecency.getTabsByRecency());
  });

  should("loadFromStorage works", async () => {
    const tabs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    stub(chrome.tabs, "query", () => Promise.resolve(tabs));

    const storage = { tabRecency: { 1: 5, 2: 6 } };
    stub(chrome.storage.session, "get", () => Promise.resolve(storage));

    // Even though the in-storage tab counters are higher than the in-memory tabs, during
    // loading, the in-memory tab counters are adjusted to be the most recent.
    await tabRecency.init();

    assert.equal([2, 1], tabRecency.getTabsByRecency());

    tabRecency.queueAction("register", 3);
    tabRecency.queueAction("register", 1);

    assert.equal([1, 3, 2], tabRecency.getTabsByRecency());
  });

  should("loadFromStorage prunes out tabs which are no longer active", async () => {
    const tabs = [{ id: 1 }];
    stub(chrome.tabs, "query", () => Promise.resolve(tabs));

    const storage = { tabRecency: { 1: 5, 2: 6 } };
    stub(chrome.storage.session, "get", () => Promise.resolve(storage));
    await tabRecency.init();
    assert.equal([1], tabRecency.getTabsByRecency());
  });

  context("tab history navigation", () => {
    function simulateActivation() {
      const currentTabId = tabRecency.tabHistory[tabRecency.tabHistoryPosition];
      tabRecency.queueAction("register", currentTabId);
    }

    setup(async () => {
      stub(chrome.tabs, "query", () => Promise.resolve([]));
      await tabRecency.init();
      // Create a history: visit tabs 1, 2, 3, 4 in order.
      tabRecency.queueAction("register", 1);
      tabRecency.queueAction("register", 2);
      tabRecency.queueAction("register", 3);
      tabRecency.queueAction("register", 4);
    });

    should("navigate history and clamp bounds", () => {
      assert.equal([1, 2, 3, 4], tabRecency.tabHistory);
      assert.equal(3, tabRecency.tabHistoryPosition);

      assert.equal(3, tabRecency.goBackInHistory());
      assert.equal(2, tabRecency.goBackInHistory());
      assert.equal(1, tabRecency.goBackInHistory());
      assert.equal(null, tabRecency.goBackInHistory());

      assert.equal(2, tabRecency.goForwardInHistory());
      assert.equal(3, tabRecency.goForwardInHistory());
      assert.equal(4, tabRecency.goForwardInHistory());
      assert.equal(null, tabRecency.goForwardInHistory());
    });

    should("discard forward history and skip additions during navigation", () => {
      tabRecency.goBackInHistory();
      simulateActivation();
      tabRecency.goBackInHistory();
      simulateActivation();
      tabRecency.queueAction("register", 5);
      assert.equal([1, 2, 5], tabRecency.tabHistory);
      assert.equal(2, tabRecency.tabHistoryPosition);

      const snapshot = [...tabRecency.tabHistory];
      tabRecency.goBackInHistory();
      tabRecency.queueAction("register", 6); // Should be ignored.
      assert.equal(snapshot, tabRecency.tabHistory);

      simulateActivation();
      tabRecency.queueAction("register", 6);
      assert.equal(6, tabRecency.tabHistory[tabRecency.tabHistory.length - 1]);
    });

    should("remove closed tabs and cap the history length", () => {
      tabRecency.queueAction("deregister", 2);
      assert.equal([1, 3, 4], tabRecency.tabHistory);
      assert.equal(2, tabRecency.tabHistoryPosition);

      tabRecency.tabHistory = [];
      tabRecency.tabHistoryPosition = -1;
      tabRecency.tabIdToCounter = {};
      for (let id = 1; id <= 60; id++) {
        tabRecency.queueAction("register", id);
      }
      assert.equal(50, tabRecency.tabHistory.length);
      assert.equal(49, tabRecency.tabHistoryPosition);
      assert.equal(11, tabRecency.tabHistory[0]);
      assert.equal(60, tabRecency.tabHistory[49]);
    });

    should("clear navigation flag when activation events arrive", () => {
      tabRecency.goBackInHistory();
      assert.isTrue(tabRecency.isNavigatingHistory);
      simulateActivation();
      assert.isFalse(tabRecency.isNavigatingHistory);
      tabRecency.queueAction("register", 5);
      assert.equal(5, tabRecency.tabHistory[tabRecency.tabHistory.length - 1]);
    });

    should("maintain relative position when removing earlier tabs", () => {
      tabRecency.goBackInHistory();
      simulateActivation();
      assert.equal(2, tabRecency.tabHistoryPosition);

      tabRecency.queueAction("deregister", 1);
      assert.equal([2, 3, 4], tabRecency.tabHistory);
      assert.equal(1, tabRecency.tabHistoryPosition);
      assert.equal(3, tabRecency.tabHistory[tabRecency.tabHistoryPosition]);
    });
  });
});
