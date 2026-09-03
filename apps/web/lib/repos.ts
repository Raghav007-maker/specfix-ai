import 'server-only';

/**
 * The single door between the web app and tenant data.
 *
 * Importing 'server-only' here means any client component that tries to pull a
 * repository in gets a build error, not a runtime leak of the pg connection into
 * the browser bundle. Every server component and server action reaches the database
 * through this module, and every function it re-exports takes a tenant_id as its
 * first argument — that is where tenant isolation actually lives.
 */
export * from '@specfix/db';
