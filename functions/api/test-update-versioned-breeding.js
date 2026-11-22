import { handleVersionedBreedingWrite } from "./_shared/versioned-breeding-write.js";

export function onRequestPost(context) {
  return handleVersionedBreedingWrite(context, "update");
}
