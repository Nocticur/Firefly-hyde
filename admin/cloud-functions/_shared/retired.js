/** Historical Cloud Functions are retained for reference, never for production. */
export function legacyServiceDisabled() {
	return Response.json({ error: "legacy_service_retired" }, {
		status: 410,
		headers: { "Cache-Control": "no-store" },
	});
}
