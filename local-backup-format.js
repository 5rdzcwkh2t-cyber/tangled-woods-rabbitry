(function (root) {
  "use strict";

  const SUPPORTED_KEYS = new Set([
    "rabbits", "litters", "breedings", "parentLinks", "expenses",
    "photos", "photoBackupVersion", "exportedAt"
  ]);

  function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function recordCollection(value, label) {
    if (!Array.isArray(value) || value.some(item => !plainObject(item))) {
      throw new Error(`${label} must be an array of records.`);
    }
    return value;
  }

  function isPhotoData(value) {
    return typeof value === "string" &&
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value);
  }

  function validatePhotos(photos) {
    if (!plainObject(photos)) return false;
    return Object.entries(photos).every(([key, value]) => {
      if (!key) return false;
      if (!key.startsWith("gallery:")) return isPhotoData(value);
      if (typeof value !== "string") return false;
      try {
        const items = JSON.parse(value);
        return Array.isArray(items) && items.length <= 9 && items.every(isPhotoData);
      } catch {
        return false;
      }
    });
  }

  function photoCount(photos) {
    return Object.entries(photos || {}).reduce((total, [key, value]) => {
      if (!key.startsWith("gallery:")) return total + 1;
      try {
        const items = JSON.parse(value);
        return total + (Array.isArray(items) ? items.length : 0);
      } catch {
        return total;
      }
    }, 0);
  }

  function prepareRestoreCandidate(backup) {
    if (!plainObject(backup)) throw new Error("Not a backup object.");
    const unsupported = Object.keys(backup).filter(key => !SUPPORTED_KEYS.has(key));
    if (unsupported.length) {
      throw new Error(`Unsupported backup data: ${unsupported.join(", ")}.`);
    }

    const rabbits = recordCollection(backup.rabbits, "Rabbits");
    const litters = recordCollection(backup.litters, "Litters");
    const breedings = backup.breedings === undefined
      ? [] : recordCollection(backup.breedings, "Breedings");
    const expenses = backup.expenses === undefined
      ? [] : recordCollection(backup.expenses, "Expenses");
    const parentLinks = backup.parentLinks === undefined ? {} : backup.parentLinks;
    if (!plainObject(parentLinks)) throw new Error("Parent links are invalid.");
    if (backup.photos !== undefined && !validatePhotos(backup.photos)) {
      throw new Error("Photographs are invalid.");
    }
    if (backup.photoBackupVersion !== undefined &&
        (!Number.isInteger(backup.photoBackupVersion) || backup.photoBackupVersion < 1)) {
      throw new Error("Photo backup version is invalid.");
    }
    if (backup.exportedAt !== undefined &&
        (typeof backup.exportedAt !== "string" || Number.isNaN(Date.parse(backup.exportedAt)))) {
      throw new Error("Backup export date is invalid.");
    }

    return {
      records: { rabbits, litters, breedings, parentLinks, expenses },
      photos: backup.photos
    };
  }

  root.twLocalBackupFormat = Object.freeze({
    prepareRestoreCandidate,
    validatePhotos,
    photoCount
  });
})(globalThis);
