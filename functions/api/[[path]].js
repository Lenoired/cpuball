export async function onRequest(context) {
    // This is the "Bridge". It has NO secrets.
    // It blindly forwards the request to your private worker.
    
    try {
        // 'MONOLITH_CORE' is the Service Binding name we will set in the dashboard.
        return await context.env.MONOLITH_CORE.fetch(context.request);
    } catch (e) {
        return new Response("Bridge Error", { status: 500 });
    }
}
