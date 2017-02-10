/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-2016 Eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

{
  /* Pages */

  let Page = ext.Page = function(tab)
  {
    this.id = tab.id;
    this._url = tab.url && new URL(tab.url);

    this.browserAction = new BrowserAction(tab.id);
    this.contextMenus = new ContextMenus(this);
  };
  Page.prototype = {
    get url()
    {
      // usually our Page objects are created from Chrome's Tab objects, which
      // provide the url. So we can return the url given in the constructor.
      if (this._url)
        return this._url;

      // but sometimes we only have the tab id when we create a Page object.
      // In that case we get the url from top frame of the tab, recorded by
      // the onBeforeRequest handler.
      let frames = framesOfTabs[this.id];
      if (frames)
      {
        let frame = frames[0];
        if (frame)
          return frame.url;
      }
    },
    sendMessage(message, responseCallback)
    {
      chrome.tabs.sendMessage(this.id, message, responseCallback);
    }
  };

  ext.getPage = id => new Page({id: parseInt(id, 10)});

  function afterTabLoaded(callback)
  {
     return openedTab =>
     {
       let onUpdated = (tabId, changeInfo, tab) =>
       {
         if (tabId == openedTab.id && changeInfo.status == "complete")
         {
           chrome.tabs.onUpdated.removeListener(onUpdated);
           callback(new Page(openedTab));
         }
       };
       chrome.tabs.onUpdated.addListener(onUpdated);
     };
  }

  ext.pages = {
    open(url, callback)
    {
      chrome.tabs.create({url: url}, callback && afterTabLoaded(callback));
    },
    query(info, callback)
    {
      let rawInfo = {};
      for (let property in info)
      {
        switch (property)
        {
          case "active":
          case "lastFocusedWindow":
            rawInfo[property] = info[property];
        }
      }

      chrome.tabs.query(rawInfo, tabs =>
      {
        callback(tabs.map(tab => new Page(tab)));
      });
    },
    onLoading: new ext._EventTarget(),
    onActivated: new ext._EventTarget(),
    onRemoved: new ext._EventTarget()
  };

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  {
    if (changeInfo.status == "loading")
      ext.pages.onLoading._dispatch(new Page(tab));
  });

  function createFrame(tabId, frameId)
  {
    let frames = framesOfTabs[tabId];
    if (!frames)
      frames = framesOfTabs[tabId] = Object.create(null);

    let frame = frames[frameId];
    if (!frame)
      frame = frames[frameId] = {};

    return frame;
  }

  chrome.webNavigation.onBeforeNavigate.addListener(details =>
  {
    // Capture parent frame here because onCommitted doesn't get this info.
    let frame = createFrame(details.tabId, details.frameId);
    frame.parent = framesOfTabs[details.tabId][details.parentFrameId] || null;
  });

  let eagerlyUpdatedPages = new ext.PageMap();

  ext._updatePageFrameStructure = (frameId, tabId, url, eager) =>
  {
    if (frameId == 0)
    {
      let page = new Page({id: tabId, url: url});

      if (eagerlyUpdatedPages.get(page) != url)
      {
        ext._removeFromAllPageMaps(tabId);

        // When a sitekey header is received we must immediately update the page
        // structure in order to record and use the key. We want to avoid
        // trashing the page structure if the onCommitted event is then fired
        // for the page.
        if (eager)
          eagerlyUpdatedPages.set(page, url);

        chrome.tabs.get(tabId, () =>
        {
          // If the tab is prerendered, chrome.tabs.get() sets
          // chrome.runtime.lastError and we have to dispatch the onLoading event,
          // since the onUpdated event isn't dispatched for prerendered tabs.
          // However, we have to keep relying on the unUpdated event for tabs that
          // are already visible. Otherwise browser action changes get overridden
          // when Chrome automatically resets them on navigation.
          if (chrome.runtime.lastError)
            ext.pages.onLoading._dispatch(page);
        });
      }
    }

    // Update frame URL in frame structure
    let frame = createFrame(tabId, frameId);
    frame.url = new URL(url);
  };

  chrome.webNavigation.onCommitted.addListener(details =>
  {
    ext._updatePageFrameStructure(details.frameId, details.tabId, details.url);
  });

  function forgetTab(tabId)
  {
    ext.pages.onRemoved._dispatch(tabId);

    ext._removeFromAllPageMaps(tabId);
    delete framesOfTabs[tabId];
  }

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) =>
  {
    forgetTab(removedTabId);
  });

  chrome.tabs.onRemoved.addListener(forgetTab);

  chrome.tabs.onActivated.addListener(details =>
  {
    ext.pages.onActivated._dispatch(new Page({id: details.tabId}));
  });


  /* Browser actions */

  let BrowserAction = function(tabId)
  {
    this._tabId = tabId;
    this._changes = null;
  };
  BrowserAction.prototype = {
    _applyChanges()
    {
      if ("iconPath" in this._changes)
      {
        chrome.browserAction.setIcon({
          tabId: this._tabId,
          path: {
            16: this._changes.iconPath.replace("$size", "16"),
            19: this._changes.iconPath.replace("$size", "19"),
            20: this._changes.iconPath.replace("$size", "20"),
            32: this._changes.iconPath.replace("$size", "32"),
            38: this._changes.iconPath.replace("$size", "38"),
            40: this._changes.iconPath.replace("$size", "40")
          }
        });
      }

      if ("badgeText" in this._changes)
      {
        chrome.browserAction.setBadgeText({
          tabId: this._tabId,
          text: this._changes.badgeText
        });
      }

      if ("badgeColor" in this._changes)
      {
        chrome.browserAction.setBadgeBackgroundColor({
          tabId: this._tabId,
          color: this._changes.badgeColor
        });
      }

      this._changes = null;
    },
    _queueChanges()
    {
      chrome.tabs.get(this._tabId, function()
      {
        // If the tab is prerendered, chrome.tabs.get() sets
        // chrome.runtime.lastError and we have to delay our changes
        // until the currently visible tab is replaced with the
        // prerendered tab. Otherwise chrome.browserAction.set* fails.
        if (chrome.runtime.lastError)
        {
          let onReplaced = (addedTabId, removedTabId) =>
          {
            if (addedTabId == this._tabId)
            {
              chrome.tabs.onReplaced.removeListener(onReplaced);
              this._applyChanges();
            }
          };
          chrome.tabs.onReplaced.addListener(onReplaced);
        }
        else
        {
          this._applyChanges();
        }
      }.bind(this));
    },
    _addChange(name, value)
    {
      if (!this._changes)
      {
        this._changes = {};
        this._queueChanges();
      }

      this._changes[name] = value;
    },
    setIcon(path)
    {
      this._addChange("iconPath", path);
    },
    setBadge(badge)
    {
      if (!badge)
      {
        this._addChange("badgeText", "");
      }
      else
      {
        if ("number" in badge)
          this._addChange("badgeText", badge.number.toString());

        if ("color" in badge)
          this._addChange("badgeColor", badge.color);
      }
    }
  };


  /* Context menus */

  let contextMenuItems = new ext.PageMap();
  let contextMenuUpdating = false;

  let updateContextMenu = () =>
  {
    if (contextMenuUpdating)
      return;

    contextMenuUpdating = true;

    chrome.tabs.query({active: true, lastFocusedWindow: true}, tabs =>
    {
      chrome.contextMenus.removeAll(() =>
      {
        contextMenuUpdating = false;

        if (tabs.length == 0)
          return;

        let items = contextMenuItems.get({id: tabs[0].id});

        if (!items)
          return;

        items.forEach(item =>
        {
          chrome.contextMenus.create({
            title: item.title,
            contexts: item.contexts,
            onclick(info, tab)
            {
              item.onclick(new Page(tab));
            }
          });
        });
      });
    });
  };

  let ContextMenus = function(page)
  {
    this._page = page;
  };
  ContextMenus.prototype = {
    create(item)
    {
      let items = contextMenuItems.get(this._page);
      if (!items)
        contextMenuItems.set(this._page, items = []);

      items.push(item);
      updateContextMenu();
    },
    remove(item)
    {
      let items = contextMenuItems.get(this._page);
      if (items)
      {
        let index = items.indexOf(item);
        if (index != -1)
        {
          items.splice(index, 1);
          updateContextMenu();
        }
      }
    }
  };

  chrome.tabs.onActivated.addListener(updateContextMenu);

  chrome.windows.onFocusChanged.addListener(windowId =>
  {
    if (windowId != chrome.windows.WINDOW_ID_NONE)
      updateContextMenu();
  });


  /* Web requests */

  let framesOfTabs = Object.create(null);

  ext.getFrame = (tabId, frameId) =>
  {
    return (framesOfTabs[tabId] || {})[frameId];
  };

  let handlerBehaviorChangedQuota = chrome.webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES;

  function propagateHandlerBehaviorChange()
  {
    // Make sure to not call handlerBehaviorChanged() more often than allowed
    // by chrome.webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES.
    // Otherwise Chrome notifies the user that this extension is causing issues.
    if (handlerBehaviorChangedQuota > 0)
    {
      chrome.webNavigation.onBeforeNavigate.removeListener(propagateHandlerBehaviorChange);
      chrome.webRequest.handlerBehaviorChanged();

      handlerBehaviorChangedQuota--;
      setTimeout(() => { handlerBehaviorChangedQuota++; }, 600000);
    }
  }

  ext.webRequest = {
    onBeforeRequest: new ext._EventTarget(),
    handlerBehaviorChanged()
    {
      // Defer handlerBehaviorChanged() until navigation occurs.
      // There wouldn't be any visible effect when calling it earlier,
      // but it's an expensive operation and that way we avoid to call
      // it multiple times, if multiple filters are added/removed.
      let onBeforeNavigate = chrome.webNavigation.onBeforeNavigate;
      if (!onBeforeNavigate.hasListener(propagateHandlerBehaviorChange))
        onBeforeNavigate.addListener(propagateHandlerBehaviorChange);
    }
  };

  chrome.tabs.query({}, tabs =>
  {
    tabs.forEach(tab =>
    {
      chrome.webNavigation.getAllFrames({tabId: tab.id}, details =>
      {
        if (details && details.length > 0)
        {
          let frames = framesOfTabs[tab.id] = Object.create(null);

          for (let i = 0; i < details.length; i++)
            frames[details[i].frameId] = {url: new URL(details[i].url), parent: null};

          for (let i = 0; i < details.length; i++)
          {
            let parentFrameId = details[i].parentFrameId;

            if (parentFrameId != -1)
              frames[details[i].frameId].parent = frames[parentFrameId];
          }
        }
      });
    });
  });

  chrome.webRequest.onBeforeRequest.addListener(details =>
  {
    // The high-level code isn't interested in requests that aren't
    // related to a tab or requests loading a top-level document,
    // those should never be blocked.
    if (details.tabId == -1 || details.type == "main_frame")
      return;

    // We are looking for the frame that contains the element which
    // has triggered this request. For most requests (e.g. images) we
    // can just use the request's frame ID, but for subdocument requests
    // (e.g. iframes) we must instead use the request's parent frame ID.
    let frameId;
    let requestType;
    if (details.type == "sub_frame")
    {
      frameId = details.parentFrameId;
      requestType = "SUBDOCUMENT";
    }
    else
    {
      frameId = details.frameId;
      requestType = details.type.toUpperCase();
    }

    let frame = ext.getFrame(details.tabId, frameId);
    if (frame)
    {
      let results = ext.webRequest.onBeforeRequest._dispatch(
        new URL(details.url),
        requestType,
        new Page({id: details.tabId}),
        frame
      );

      if (results.indexOf(false) != -1)
        return {cancel: true};
    }
  }, {urls: ["http://*/*", "https://*/*"]}, ["blocking"]);


  /* Message passing */

  chrome.runtime.onMessage.addListener((message, rawSender, sendResponse) =>
  {
    let sender = {};

    // Add "page" and "frame" if the message was sent by a content script.
    // If sent by popup or the background page itself, there is no "tab".
    if ("tab" in rawSender)
    {
      sender.page = new Page(rawSender.tab);
      sender.frame = {
        // In Edge requests from internal extension pages
        // (protocol ms-browser-extension://) do no have a sender URL.
        url: rawSender.url ? new URL(rawSender.url) : null,
        get parent()
        {
          let frames = framesOfTabs[rawSender.tab.id];

          if (!frames)
            return null;

          let frame = frames[rawSender.frameId];
          if (frame)
            return frame.parent;

          return frames[0];
        }
      };
    }

    return ext.onMessage._dispatch(message, sender, sendResponse).indexOf(true) != -1;
  });


  /* Storage */

  ext.storage = {
    get(keys, callback)
    {
      chrome.storage.local.get(keys, callback);
    },
    set(key, value, callback)
    {
      let items = {};
      items[key] = value;
      chrome.storage.local.set(items, callback);
    },
    remove(key, callback)
    {
      chrome.storage.local.remove(key, callback);
    },
    onChanged: chrome.storage.onChanged
  };

  /* Options */

  if ("openOptionsPage" in chrome.runtime)
  {
    ext.showOptions = callback =>
    {
      if (!callback)
      {
        chrome.runtime.openOptionsPage();
      }
      else
      {
        chrome.runtime.openOptionsPage(() =>
        {
          if (chrome.runtime.lastError)
            return;

          chrome.tabs.query({active: true, lastFocusedWindow: true}, tabs =>
          {
            if (tabs.length > 0)
            {
              window.setTimeout(() =>
              {
                callback(new Page(tabs[0]));
              });
            }
          });
        });
      }
    };
  }
  else
  {
    // Edge does not yet support runtime.openOptionsPage (tested version 38)
    // and so this workaround needs to stay for now.
    ext.showOptions = callback =>
    {
      chrome.windows.getLastFocused(win =>
      {
        let optionsUrl = chrome.extension.getURL("options.html");
        let queryInfo = {url: optionsUrl};

        // extension pages can't be accessed in incognito windows. In order to
        // correctly mimic the way in which Chrome opens extension options,
        // we have to focus the options page in any other window.
        if (!win.incognito)
          queryInfo.windowId = win.id;

        chrome.tabs.query(queryInfo, tabs =>
        {
          if (tabs.length > 0)
          {
            let tab = tabs[0];

            chrome.windows.update(tab.windowId, {focused: true});
            chrome.tabs.update(tab.id, {active: true});

            if (callback)
              callback(new Page(tab));
          }
          else
          {
            ext.pages.open(optionsUrl, callback);
          }
        });
      });
    };
  }

  /* Windows */
  ext.windows = {
    create(createData, callback)
    {
      if ("create" in chrome.windows){
        chrome.windows.create(createData, createdWindow =>
        {
            afterTabLoaded(callback)(createdWindow.tabs[0]);
        });
      }
      else
      {
        ext.pages.open(createData.url, callback);
      }
    }
  };
}
