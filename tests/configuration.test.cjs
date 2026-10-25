const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { startupFailure, ConfigurationError, forwardedEndpoint } = require(process.env.OTF_TEST_BUNDLE);

test('startup names invalid/missing settings while hiding all configuration values', () => {
    for (const [plugin, keys, table, url, setting, reason] of [
        [undefined, undefined, undefined, undefined, 'AUTHENTICATION_PLUGIN', 'missing'],
        ['fake-plugin-secret', undefined, undefined, undefined, 'AUTHENTICATION_PLUGIN', 'unsupported'],
        ['EnvironmentVariableAuthenticationPlugin', undefined, undefined, undefined, 'DEVICE_KEYS', 'missing'],
        ['MySQLAuthenticationPlugin', undefined, undefined, 'mysql://fake-user:fake-password-secret@localhost/fake-db', 'MYSQL_TABLE', 'missing'],
        ['MySQLAuthenticationPlugin', undefined, 'fake-table-secret', undefined, 'MYSQL_CONNECTION_URL', 'missing'],
        ['MySQLAuthenticationPlugin', undefined, 'fake-table-secret', 'mysql://bad%ZZ:fake-password-secret@localhost/db', 'MYSQL_CONNECTION_URL', 'invalid'],
    ]) {
        const env = { ...process.env, LOG_LEVEL: 'info' };
        for (const [key, value] of Object.entries({ AUTHENTICATION_PLUGIN: plugin, DEVICE_KEYS: keys,
            MYSQL_TABLE: table, MYSQL_CONNECTION_URL: url })) {
            if (value === undefined) delete env[key];
            else env[key] = value;
        }
        const child = spawnSync(process.execPath, ['dist/index.cjs'], { env, encoding: 'utf8', timeout: 3000 });
        assert.equal(child.status, 1, child.stdout + child.stderr);
        const lines = child.stdout.trim().split('\n').map(line => JSON.parse(line));
        const fatal = lines.find(line => line.event === 'startup_failure');
        assert.equal(fatal.setting, setting);
        assert.equal(fatal.reason, reason);
        assert.match(fatal.msg, new RegExp(setting));
        for (const secret of ['fake-plugin-secret', 'fake-table-secret', 'fake-password-secret', 'bad%ZZ']) {
            assert.equal((child.stdout + child.stderr).includes(secret), false);
        }
    }
});

test('unrecognized startup errors cannot leak URLs, SQL or payloads; safe system codes remain', () => {
    const failure = startupFailure(Object.assign(new Error('mysql://user:fake-secret@host/db'), {
        sql: 'SELECT fake-secret', code: 'EADDRINUSE',
    }));
    assert.equal(failure.errorCode, 'EADDRINUSE');
    assert.equal(JSON.stringify(failure).includes('fake-secret'), false);
    assert.equal(startupFailure({ code: 'fake-secret', message: 'fake-secret' }).errorCode, undefined);
    assert.equal(startupFailure(new ConfigurationError('MYSQL_TABLE', 'missing')).setting, 'MYSQL_TABLE');
});

test('endpoint logging distinguishes controller operations while dropping secrets and arbitrary paths', () => {
    assert.equal(forwardedEndpoint('/forward/v1/fake-token/jc?pw=fake-secret'), '/jc');
    assert.equal(forwardedEndpoint('/forward/v1/fake-token/cm?sid=1&en=1'), '/cm');
    assert.equal(forwardedEndpoint('/forward/v1/fake-token/s2id_gen'), '/s2id_gen');
    assert.equal(forwardedEndpoint('/forward/v1/fake-token/jc/fake-path-secret'), '/jc');
    assert.equal(forwardedEndpoint('/forward/v1/fake-token/fake-path-secret'), '/other');
    assert.equal(forwardedEndpoint('/forward/v1/fake-token/%6ac?pw=fake-secret'), '/other');
    assert.equal(forwardedEndpoint('/forward/v1/fake-token?pw=fake-secret'), '/');
    assert.equal(forwardedEndpoint('/fake-secret'), undefined);
});
