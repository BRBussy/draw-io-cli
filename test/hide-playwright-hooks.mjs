/**
 * A resolve hook that makes the playwright package unresolvable, with the
 * exact error a checkout that never installed it raises. Registered by
 * test/hide-playwright.mjs.
 */
export async function resolve(specifier, context, next) {
  if (specifier === "playwright") {
    const error = new Error("Cannot find package 'playwright' imported from the drawio-cli source");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return next(specifier, context);
}
