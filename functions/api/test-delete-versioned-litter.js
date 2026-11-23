import { handleVersionedLitterWrite } from "./_shared/versioned-litter-write.js";
export function onRequestPost(context) { return handleVersionedLitterWrite(context, "delete"); }
