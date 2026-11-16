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

  function recordId(record, prefix, index) {
    return String(record._id || record.id || `${prefix}-import-${index}`);
  }

  function verificationCounts(candidate) {
    const { records, photos } = candidate;
    return {
      rabbits: records.rabbits.length,
      litters: records.litters.length,
      breedings: records.breedings.length,
      pedigreeLinks: Object.keys(records.parentLinks).length,
      expenses: records.expenses.length,
      photographs: photoCount(photos)
    };
  }

  function verifyBackup(backup) {
    let candidate;
    try {
      candidate = prepareRestoreCandidate(backup);
    } catch (error) {
      return {
        valid: false,
        errors: [error instanceof Error ? error.message : "Backup validation failed."],
        warnings: [],
        counts: null
      };
    }

    const errors = [];
    const warnings = [];
    const { rabbits, litters, breedings, parentLinks, expenses } = candidate.records;
    const collections = [
      ["rabbit", rabbits, "r"],
      ["litter", litters, "l"],
      ["breeding", breedings, "b"],
      ["expense", expenses, "exp"]
    ];
    const ids = new Map();
    for (const [label, records, prefix] of collections) {
      const seen = new Set();
      records.forEach((record, index) => {
        const id = recordId(record, prefix, index);
        if (seen.has(id)) errors.push(`Duplicate ${label} ID: ${id}.`);
        seen.add(id);
      });
      ids.set(label, seen);
    }

    const rabbitIds = ids.get("rabbit");
    const litterIds = ids.get("litter");
    const breedingIds = ids.get("breeding");
    const rabbitById = new Map(rabbits.map((record, index) =>
      [recordId(record, "r", index), record]));

    function missingRabbit(id, context) {
      if (id !== undefined && id !== null && String(id) && !rabbitIds.has(String(id))) {
        warnings.push(`${context} references missing rabbit ${String(id)}.`);
      }
    }

    rabbits.forEach((rabbit, index) => {
      const id = recordId(rabbit, "r", index);
      if (rabbit.litterId && !litterIds.has(String(rabbit.litterId))) {
        warnings.push(`Rabbit ${id} references missing litter ${String(rabbit.litterId)}.`);
      }
      for (const [field, role] of [["FatherID", "father"], ["MotherID", "mother"]]) {
        missingRabbit(rabbit[field], `Rabbit ${id} ${role}`);
      }
    });

    litters.forEach((litter, index) => {
      const id = recordId(litter, "l", index);
      const damId = litter.DamID || litter.MotherID;
      const sireId = litter.SireID || litter.FatherID;
      missingRabbit(damId, `Litter ${id} dam`);
      missingRabbit(sireId, `Litter ${id} sire`);
      if (damId && sireId && String(damId) === String(sireId)) {
        warnings.push(`Litter ${id} uses the same rabbit as dam and sire.`);
      }
      if (litter.breedingId && !breedingIds.has(String(litter.breedingId))) {
        warnings.push(`Litter ${id} references missing breeding ${String(litter.breedingId)}.`);
      }
      if (Array.isArray(litter.kits)) {
        litter.kits.forEach((kit, kitIndex) => {
          if (kit && typeof kit === "object" && kit.rabbitId) {
            missingRabbit(kit.rabbitId, `Litter ${id} kit ${kitIndex + 1}`);
          }
        });
      }
    });

    breedings.forEach((breeding, index) => {
      const id = recordId(breeding, "b", index);
      missingRabbit(breeding.doeId, `Breeding ${id} doe`);
      missingRabbit(breeding.buckId, `Breeding ${id} buck`);
      if (breeding.doeId && breeding.buckId &&
          String(breeding.doeId) === String(breeding.buckId)) {
        warnings.push(`Breeding ${id} uses the same rabbit as doe and buck.`);
      }
      const doe = rabbitById.get(String(breeding.doeId || ""));
      const buck = rabbitById.get(String(breeding.buckId || ""));
      if (doe && String(doe.Sex || "").toLowerCase() !== "doe") {
        warnings.push(`Breeding ${id} doe does not reference a Doe record.`);
      }
      if (buck && String(buck.Sex || "").toLowerCase() !== "buck") {
        warnings.push(`Breeding ${id} buck does not reference a Buck record.`);
      }
    });

    for (const [key, link] of Object.entries(parentLinks)) {
      const separator = key.lastIndexOf("|");
      if (separator > 0) {
        const childId = key.slice(0, separator);
        if (!rabbitIds.has(childId)) {
          warnings.push(`Pedigree link ${key} references missing child rabbit ${childId}.`);
        }
      }
      if (plainObject(link) && link.kind === "record") {
        missingRabbit(link.id, `Pedigree link ${key}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      counts: verificationCounts(candidate)
    };
  }

  root.twLocalBackupFormat = Object.freeze({
    prepareRestoreCandidate,
    verifyBackup,
    validatePhotos,
    photoCount
  });
})(globalThis);
