function handler(event) {
    var request = event.request;
    var host = request.headers.host.value;

    if (host === 'site.kcmps.com') {
        var qs = '';
        var keys = Object.keys(request.querystring);
        if (keys.length > 0) {
            var parts = [];
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                var v = request.querystring[k].value;
                parts.push(v ? k + '=' + v : k);
            }
            qs = '?' + parts.join('&');
        }
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: {
                'location': { value: 'https://kcmps.com' + request.uri + qs }
            }
        };
    }

    return request;
}