/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";
import { approveAll, type SessionEvent, type SessionStoreConfig } from "../../src/index.js";
import { createSdkTestContext } from "./harness/sdkTestContext.js";
import { getFinalAssistantMessage } from "./harness/sdkTestHelper.js";

/**
 * In-memory session event store for testing.
 * Stores events in a Map keyed by sessionId, and tracks call counts
 * for each operation so tests can assert they were invoked.
 */
class InMemorySessionStore {
    private sessions = new Map<string, SessionEvent[]>();
    readonly calls = {
        load: 0,
        append: 0,
        truncate: 0,
        listSessions: 0,
        delete: 0,
    };

    toConfig(descriptor: string): SessionStoreConfig {
        return {
            descriptor,
            onLoad: async (sessionId) => {
                this.calls.load++;
                return this.sessions.get(sessionId) ?? [];
            },
            onAppend: async (events, sessionId) => {
                this.calls.append++;
                const existing = this.sessions.get(sessionId) ?? [];
                existing.push(...events);
                this.sessions.set(sessionId, existing);
            },
            onTruncate: async (upToEventId, sessionId) => {
                this.calls.truncate++;
                const existing = this.sessions.get(sessionId) ?? [];
                const idx = existing.findIndex((e) => e.id === upToEventId);
                if (idx === -1) {
                    return { eventsRemoved: 0, eventsKept: existing.length };
                }
                const kept = existing.slice(idx + 1);
                this.sessions.set(sessionId, kept);
                return { eventsRemoved: idx + 1, eventsKept: kept.length };
            },
            onListSessions: async () => {
                this.calls.listSessions++;
                const now = new Date().toISOString();
                return Array.from(this.sessions.keys()).map((sessionId) => ({
                    sessionId,
                    mtime: now,
                    birthtime: now,
                }));
            },
            onDelete: async (sessionId) => {
                this.calls.delete++;
                this.sessions.delete(sessionId);
            },
        };
    }

    getEvents(sessionId: string): SessionEvent[] {
        return this.sessions.get(sessionId) ?? [];
    }

    hasSession(sessionId: string): boolean {
        return this.sessions.has(sessionId);
    }

    get sessionCount(): number {
        return this.sessions.size;
    }
}

describe("Session Store", async () => {
    const { copilotClient: client } = await createSdkTestContext();

    it("should persist events to a client-supplied store", async () => {
        const store = new InMemorySessionStore();
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            sessionStore: store.toConfig("memory://test-persist"),
        });

        // Send a message and wait for the response
        const msg = await session.sendAndWait({ prompt: "What is 100 + 200?" });
        expect(msg?.data.content).toContain("300");

        // Verify onAppend was called — events should have been routed to our store.
        // The SessionWriter uses debounced flushing, so poll until events arrive.
        await vi.waitFor(
            () => {
                const events = store.getEvents(session.sessionId);
                const eventTypes = events.map((e) => e.type);
                expect(eventTypes).toContain("session.start");
                expect(eventTypes).toContain("user.message");
                expect(eventTypes).toContain("assistant.message");
            },
            { timeout: 10_000, interval: 200 },
        );
        expect(store.calls.append).toBeGreaterThan(0);
    });

    it("should load events from a client-supplied store on resume", async () => {
        const store = new InMemorySessionStore();
        const storeConfig = store.toConfig("memory://test-resume");

        // Create a session and send a message
        const session1 = await client.createSession({
            onPermissionRequest: approveAll,
            sessionStore: storeConfig,
        });
        const sessionId = session1.sessionId;

        const msg1 = await session1.sendAndWait({ prompt: "What is 50 + 50?" });
        expect(msg1?.data.content).toContain("100");
        await session1.disconnect();

        // Verify onLoad is called when resuming
        const loadCountBefore = store.calls.load;
        const session2 = await client.resumeSession(sessionId, {
            onPermissionRequest: approveAll,
            sessionStore: storeConfig,
        });

        expect(store.calls.load).toBeGreaterThan(loadCountBefore);

        // Send another message to verify the session is functional
        const msg2 = await session2.sendAndWait({ prompt: "What is that times 3?" });
        expect(msg2?.data.content).toContain("300");
    });

    it("should use client-supplied store for listSessions", async () => {
        const store = new InMemorySessionStore();
        const storeConfig = store.toConfig("memory://test-list");

        // Create a session and send a message to trigger event flushing
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            sessionStore: storeConfig,
        });
        await session.sendAndWait({ prompt: "What is 10 + 10?" });

        // Wait for events to be flushed (debounced)
        await vi.waitFor(
            () => expect(store.hasSession(session.sessionId)).toBe(true),
            { timeout: 10_000, interval: 200 },
        );

        // List sessions using the same store
        const sessions = await client.listSessions({ sessionStore: storeConfig });
        expect(store.calls.listSessions).toBeGreaterThan(0);
        expect(sessions.some((s) => s.sessionId === session.sessionId)).toBe(true);
    });

    it("should reject resume with a different store descriptor", async () => {
        const store1 = new InMemorySessionStore();
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            sessionStore: store1.toConfig("memory://store-alpha"),
        });
        const sessionId = session.sessionId;

        // Don't disconnect — session is still active.
        // Try to resume with a different descriptor.
        const store2 = new InMemorySessionStore();
        await expect(
            client.resumeSession(sessionId, {
                onPermissionRequest: approveAll,
                sessionStore: store2.toConfig("memory://store-beta"),
            }),
        ).rejects.toThrow(/Cannot change storage backend/);
    });
});
