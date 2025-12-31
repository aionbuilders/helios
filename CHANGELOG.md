# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-01-01

### Added

#### Session Recovery (P0-1)
- JWT-based session tokens with configurable TTL (default: 5 minutes)
- Automatic reconnection with state preservation using WebSocket URL parameters
- Session refresh with rate limiting (min TTL/2 between refreshes)
- Built-in RPC method `session.refresh` for token renewal
- In-memory session storage with automatic cleanup
- Events: `session:created`, `session:recovered`, `session:refreshed`
- Full Connection instance preservation (data Map, subscriptions, pending requests)

#### Health Checks (P0-2)
- Automatic ping/pong keep-alive mechanism
- Configurable interval (default: 30s), timeout (default: 10s), and max missed pongs (default: 2)
- Dead connection detection with automatic cleanup
- Per-connection health check timers
- Events: `ping-timeout`, `ping-missed`, `pong-received` (with latency)
- Manual ping API for connection latency testing

#### Room Manager (P1-5)
- Public and protected room types
- Pattern-based room declarations with capture groups (*, **, ++)
- Validator functions with async support
- Specificity-based pattern matching (most specific first)
- Built-in RPC methods: `helios.subscribe`, `helios.unsubscribe`
- Broadcast to exact topics or patterns
- Dual-index system for O(1) exact matches and O(n*m) pattern matches
- Events: `room:subscribed`, `room:unsubscribed`
- Automatic cleanup on disconnection/session expiry

#### Core Features
- Complete WebSocket connection lifecycle management
- Request/Response tracking with timeout and cleanup
- Method registration with middleware support (global and namespace)
- Event subscription with middleware support
- Namespace support for method organization
- Comprehensive event system via @killiandvcz/pulse
- Connection data storage via Map
- Parse modes: strict, permissive
- Proper cleanup on disconnection (requests, events, data, rooms)

### Features

- Native Bun.serve WebSocket integration
- Zero-copy message handling via @aionbuilders/helios-protocol
- Efficient pattern matching with CapturePatternMatcher
- Proper resource cleanup and memory management
- TypeScript definitions via JSDoc
- Comprehensive documentation

### Dependencies
- `@aionbuilders/helios-protocol` ^1.1.0 - Core protocol implementation
- `@killiandvcz/pulse` ^2.1.3 - Event system
- `jose` ^6.1.3 - JWT handling for session recovery

### Security
- HMAC-based JWT signatures (HS256)
- Short TTL windows (configurable, default 5 minutes)
- Rate limiting on token refresh
- Session expiry and cleanup

### Performance
- JWT signing/verification: <1ms
- Memory per session: <1KB
- O(1) exact topic lookups for rooms
- Minimal overhead on message handling

### Breaking Changes
None - Initial release

[1.0.0]: https://github.com/aionbuilders/helios/releases/tag/v1.0.0
