// NOTE: credential literals redacted by infra-snapshot.sh before commit.
// Restore the real value from the owner's password manager.
function handler(event) {
    var request = event.request;
    var headers = request.headers;
    var expected = "Basic <REDACTED — see password manager>";

    if (
        typeof headers.authorization === "undefined" ||
        headers.authorization.value !== expected
    ) {
        return {
            statusCode: 401,
            statusDescription: "Unauthorized",
            headers: {
                "www-authenticate": { value: 'Basic realm="KCMPS dev"' }
            }
        };
    }

    return request;
}
