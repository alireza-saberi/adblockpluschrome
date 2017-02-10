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

const keyPrefix = "file:";

function fileToKey(file)
{
  return keyPrefix + (file instanceof FakeFile ? file.path : file.spec);
}

function loadFile(file, successCallback, errorCallback)
{
  let key = fileToKey(file);

  // Make sure we do not have subscriptions in localStorage from older
  // versions first
  let entry = localStorage.getItem(key);
  if (typeof entry == "string")
  {
    try
    {
      entry = JSON.parse(entry);
    }
    catch(err) 
    {
      setTimeout(errorCallback(new Error("File is corrupted")));
      return;
    }
    setTimeout(successCallback(entry));
    return;
  }
  // Now try to read from IndexedDB
  localforage.getItem(key, function(err, value) 
  {
    if (err || !value)
      errorCallback(new Error("File doesn't exist"));
    else
      successCallback(value);
  });
}

function saveFile(file, data, callback)
{
  var key = fileToKey(file);
  var entry = {
    content: Array.from(data),
    lastModified: Date.now()
  };

  localStorage.removeItem(key);
  localforage.setItem(key, entry, callback);
}

exports.IO =
{
  resolveFilePath(path) { return new FakeFile(path); },

  readFromFile(file, listener, callback)
  {
    function onLoaded(entry)
    {
      if ("content" in entry)
      {
        for (let line of entry.content)
          listener.process(line);
      }
      listener.process(null);
      callback(null);
    }

    loadFile(file, onLoaded, callback);
  },

  writeToFile(file, data, callback)
  {
    saveFile(file, data, callback);
  },

  copyFile(fromFile, toFile, callback)
  {
    function onLoaded(entry)
    {
      saveFile(toFile, entry.content, callback);
    }

    loadFile(fromFile, onLoaded, callback);
  },

  renameFile(fromFile, newName, callback)
  {
    function onLoaded(entry)
    {
      ext.storage.remove(fileToKey(fromFile), () =>
      {
        ext.storage.set(keyPrefix + newName, entry, callback);
      });
    }

    loadFile(fromFile, onLoaded, callback);
  },

  removeFile(file, callback)
  {
    ext.storage.remove(fileToKey(file), callback);
  },

  statFile(file, callback)
  {
    function onLoaded(entry)
    {
      callback(null, {
        exists: true,
        lastModified: entry.lastModified
      });
    }

    loadFile(file, onLoaded, callback);
  }
};
