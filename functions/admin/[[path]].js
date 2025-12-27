export async function onRequest(context) {
  // This bridge captures everything starting with /admin/
  // and forwards it to the same private worker.
  
  try {
    return await context.env.MONOLITH_CORE.fetch(context.request);
  } catch (e) {
    return new Response("Admin Bridge Error", { status: 500 });
  }
}
