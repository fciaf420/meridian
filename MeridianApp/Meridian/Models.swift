//
//  Models.swift
//  Meridian
//
//  Defensive Codable models for the meridian DLMM backend payloads.
//
//  ROBUSTNESS RULE: every field is optional with a sane default, decoding is
//  lenient (numbers may arrive as strings, missing keys are tolerated), and
//  nothing ever force-unwraps or crashes on an unexpected/missing field.
//

import Foundation

// MARK: - Lenient decoding helpers

/// A value that may arrive as a number OR a numeric string OR be missing.
/// Decodes to Double when possible, otherwise nil — never throws.
struct LenientDouble: Codable, Sendable, Equatable {
    let value: Double?

    init(_ value: Double?) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = nil
        } else if let d = try? container.decode(Double.self) {
            value = d
        } else if let i = try? container.decode(Int.self) {
            value = Double(i)
        } else if let b = try? container.decode(Bool.self) {
            value = b ? 1 : 0
        } else if let s = try? container.decode(String.self) {
            value = Double(s.trimmingCharacters(in: .whitespaces))
        } else {
            value = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let value { try container.encode(value) } else { try container.encodeNil() }
    }
}

/// A value that may arrive as an int, double, or numeric string.
struct LenientInt: Codable, Sendable, Equatable {
    let value: Int?

    init(_ value: Int?) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = nil
        } else if let i = try? container.decode(Int.self) {
            value = i
        } else if let d = try? container.decode(Double.self) {
            value = Int(d)
        } else if let s = try? container.decode(String.self) {
            value = Int(s.trimmingCharacters(in: .whitespaces)) ?? Double(s).map { Int($0) }
        } else {
            value = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let value { try container.encode(value) } else { try container.encodeNil() }
    }
}

/// A value that may arrive as a bool, "true"/"false" string, or 0/1 number.
struct LenientBool: Codable, Sendable, Equatable {
    let value: Bool?

    init(_ value: Bool?) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = nil
        } else if let b = try? container.decode(Bool.self) {
            value = b
        } else if let i = try? container.decode(Int.self) {
            value = i != 0
        } else if let d = try? container.decode(Double.self) {
            value = d != 0
        } else if let s = try? container.decode(String.self) {
            switch s.lowercased() {
            case "true", "1", "yes": value = true
            case "false", "0", "no": value = false
            default: value = nil
            }
        } else {
            value = nil
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let value { try container.encode(value) } else { try container.encodeNil() }
    }
}

/// Lenient keyed-container helpers — never throw, always fall back.
extension KeyedDecodingContainer {
    func lenientDouble(_ key: Key) -> Double? {
        (try? decodeIfPresent(LenientDouble.self, forKey: key))?.flatMap { $0.value }
    }
    func lenientInt(_ key: Key) -> Int? {
        (try? decodeIfPresent(LenientInt.self, forKey: key))?.flatMap { $0.value }
    }
    func lenientBool(_ key: Key) -> Bool? {
        (try? decodeIfPresent(LenientBool.self, forKey: key))?.flatMap { $0.value }
    }
    func lenientString(_ key: Key) -> String? {
        (try? decodeIfPresent(String.self, forKey: key)) ?? nil
    }
    func lenientArray<T: Decodable>(_ key: Key, of type: T.Type) -> [T] {
        ((try? decodeIfPresent([T].self, forKey: key)) ?? nil) ?? []
    }
    func lenientObject<T: Decodable>(_ key: Key, of type: T.Type) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

/// Decodes arbitrary JSON (object/array/scalar) without crashing. Used for the
/// free-form `data` payloads on notifications and quick-action results.
enum AnyJSON: Codable, Sendable, Equatable {
    case string(String)
    case double(Double)
    case bool(Bool)
    case object([String: AnyJSON])
    case array([AnyJSON])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let d = try? container.decode(Double.self) {
            self = .double(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let arr = try? container.decode([AnyJSON].self) {
            self = .array(arr)
        } else if let obj = try? container.decode([String: AnyJSON].self) {
            self = .object(obj)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .double(let d): try container.encode(d)
        case .bool(let b): try container.encode(b)
        case .object(let o): try container.encode(o)
        case .array(let a): try container.encode(a)
        case .null: try container.encodeNil()
        }
    }

    // Convenience accessors
    var stringValue: String? {
        switch self {
        case .string(let s): return s
        case .double(let d): return d == d.rounded() ? String(Int(d)) : String(d)
        case .bool(let b): return String(b)
        default: return nil
        }
    }
    var doubleValue: Double? {
        switch self {
        case .double(let d): return d
        case .string(let s): return Double(s)
        case .bool(let b): return b ? 1 : 0
        default: return nil
        }
    }
    var objectValue: [String: AnyJSON]? {
        if case .object(let o) = self { return o }
        return nil
    }
    var arrayValue: [AnyJSON]? {
        if case .array(let a) = self { return a }
        return nil
    }
    subscript(_ key: String) -> AnyJSON? {
        objectValue?[key]
    }
}

// MARK: - Wallet

/// Maps to getWalletBalances():
/// { wallet, sol, sol_price, sol_usd, usdc, tokens:[...], total_usd, error? }
struct Wallet: Codable, Sendable, Equatable {
    var wallet: String? = nil
    var sol: Double? = nil
    var solPrice: Double? = nil
    var solUsd: Double? = nil
    var usdc: Double? = nil
    var tokens: [TokenBalance] = []
    var totalUsd: Double? = nil
    var error: String? = nil

    enum CodingKeys: String, CodingKey {
        case wallet
        case sol
        case solPrice = "sol_price"
        case solUsd = "sol_usd"
        case usdc
        case tokens
        case totalUsd = "total_usd"
        case error
    }

    init(wallet: String? = nil, sol: Double? = nil, solPrice: Double? = nil,
         solUsd: Double? = nil, usdc: Double? = nil, tokens: [TokenBalance] = [],
         totalUsd: Double? = nil, error: String? = nil) {
        self.wallet = wallet
        self.sol = sol
        self.solPrice = solPrice
        self.solUsd = solUsd
        self.usdc = usdc
        self.tokens = tokens
        self.totalUsd = totalUsd
        self.error = error
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        wallet = c.lenientString(.wallet)
        sol = c.lenientDouble(.sol)
        solPrice = c.lenientDouble(.solPrice)
        solUsd = c.lenientDouble(.solUsd)
        usdc = c.lenientDouble(.usdc)
        totalUsd = c.lenientDouble(.totalUsd)
        error = c.lenientString(.error)
        tokens = c.lenientArray(.tokens, of: TokenBalance.self)
    }
}

/// Maps to a wallet token entry: { mint, symbol, balance, usd }
struct TokenBalance: Codable, Sendable, Equatable, Identifiable {
    var mint: String? = nil
    var symbol: String? = nil
    var balance: Double? = nil
    var usd: Double? = nil

    var id: String { mint ?? symbol ?? UUID().uuidString }

    enum CodingKeys: String, CodingKey {
        case mint, symbol, balance, usd
    }

    init(mint: String? = nil, symbol: String? = nil, balance: Double? = nil, usd: Double? = nil) {
        self.mint = mint
        self.symbol = symbol
        self.balance = balance
        self.usd = usd
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        mint = c.lenientString(.mint)
        symbol = c.lenientString(.symbol)
        balance = c.lenientDouble(.balance)
        usd = c.lenientDouble(.usd)
    }
}

// MARK: - Positions

/// Maps to getMyPositions(): { wallet, total_positions, positions:[...], error? }
struct PositionsPayload: Codable, Sendable, Equatable {
    var wallet: String? = nil
    var totalPositions: Int? = nil
    var positions: [Position] = []
    var error: String? = nil

    enum CodingKeys: String, CodingKey {
        case wallet
        case totalPositions = "total_positions"
        case positions
        case error
    }

    init(wallet: String? = nil, totalPositions: Int? = nil,
         positions: [Position] = [], error: String? = nil) {
        self.wallet = wallet
        self.totalPositions = totalPositions
        self.positions = positions
        self.error = error
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        wallet = c.lenientString(.wallet)
        totalPositions = c.lenientInt(.totalPositions)
        error = c.lenientString(.error)
        positions = c.lenientArray(.positions, of: Position.self)
    }
}

/// Maps to a position entry from getMyPositions().positions[].
struct Position: Codable, Sendable, Equatable, Identifiable {
    var position: String? = nil
    var pool: String? = nil
    var pair: String? = nil
    var baseMint: String? = nil
    var strategy: String? = nil
    var strategyProfile: String? = nil
    var strategyType: String? = nil
    var solSplitPct: Double? = nil
    var binStep: Int? = nil
    var volatility: Double? = nil
    var lowerBin: Int? = nil
    var upperBin: Int? = nil
    var activeBin: Int? = nil
    var inRange: Bool? = nil
    var oorDirection: String? = nil
    var unclaimedFeesUsd: Double? = nil
    var unclaimedFeesSol: Double? = nil
    var totalValueUsd: Double? = nil
    var totalValueSol: Double? = nil
    var collectedFeesUsd: Double? = nil
    var collectedFeesSol: Double? = nil
    var pnlUsd: Double? = nil
    var pnlSol: Double? = nil
    var pnlPct: Double? = nil
    var solPrice: Double? = nil
    var pnlUnit: String? = nil
    var ageMinutes: Double? = nil
    var minutesOutOfRange: Double? = nil

    var id: String { position ?? "\(pool ?? "")-\(pair ?? "")" }

    enum CodingKeys: String, CodingKey {
        case position, pool, pair
        case baseMint = "base_mint"
        case strategy
        case strategyProfile = "strategy_profile"
        case strategyType = "strategy_type"
        case solSplitPct = "sol_split_pct"
        case binStep = "bin_step"
        case volatility
        case lowerBin = "lower_bin"
        case upperBin = "upper_bin"
        case activeBin = "active_bin"
        case inRange = "in_range"
        case oorDirection = "oor_direction"
        case unclaimedFeesUsd = "unclaimed_fees_usd"
        case unclaimedFeesSol = "unclaimed_fees_sol"
        case totalValueUsd = "total_value_usd"
        case totalValueSol = "total_value_sol"
        case collectedFeesUsd = "collected_fees_usd"
        case collectedFeesSol = "collected_fees_sol"
        case pnlUsd = "pnl_usd"
        case pnlSol = "pnl_sol"
        case pnlPct = "pnl_pct"
        case solPrice = "sol_price"
        case pnlUnit = "pnl_unit"
        case ageMinutes = "age_minutes"
        case minutesOutOfRange = "minutes_out_of_range"
    }

    init() {}

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        position = c.lenientString(.position)
        pool = c.lenientString(.pool)
        pair = c.lenientString(.pair)
        baseMint = c.lenientString(.baseMint)
        strategy = c.lenientString(.strategy)
        strategyProfile = c.lenientString(.strategyProfile)
        strategyType = c.lenientString(.strategyType)
        solSplitPct = c.lenientDouble(.solSplitPct)
        binStep = c.lenientInt(.binStep)
        volatility = c.lenientDouble(.volatility)
        lowerBin = c.lenientInt(.lowerBin)
        upperBin = c.lenientInt(.upperBin)
        activeBin = c.lenientInt(.activeBin)
        inRange = c.lenientBool(.inRange)
        oorDirection = c.lenientString(.oorDirection)
        unclaimedFeesUsd = c.lenientDouble(.unclaimedFeesUsd)
        unclaimedFeesSol = c.lenientDouble(.unclaimedFeesSol)
        totalValueUsd = c.lenientDouble(.totalValueUsd)
        totalValueSol = c.lenientDouble(.totalValueSol)
        collectedFeesUsd = c.lenientDouble(.collectedFeesUsd)
        collectedFeesSol = c.lenientDouble(.collectedFeesSol)
        pnlUsd = c.lenientDouble(.pnlUsd)
        pnlSol = c.lenientDouble(.pnlSol)
        pnlPct = c.lenientDouble(.pnlPct)
        solPrice = c.lenientDouble(.solPrice)
        pnlUnit = c.lenientString(.pnlUnit)
        ageMinutes = c.lenientDouble(.ageMinutes)
        minutesOutOfRange = c.lenientDouble(.minutesOutOfRange)
    }
}

// MARK: - Candidates

/// Maps to normalizeCandidatesPayload():
/// { candidates:[...], total_eligible, total_screened }
struct CandidatesPayload: Codable, Sendable, Equatable {
    var candidates: [Candidate] = []
    var totalEligible: Int? = nil
    var totalScreened: Int? = nil

    enum CodingKeys: String, CodingKey {
        case candidates
        case totalEligible = "total_eligible"
        case totalScreened = "total_screened"
    }

    init(candidates: [Candidate] = [], totalEligible: Int? = nil, totalScreened: Int? = nil) {
        self.candidates = candidates
        self.totalEligible = totalEligible
        self.totalScreened = totalScreened
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        totalEligible = c.lenientInt(.totalEligible)
        totalScreened = c.lenientInt(.totalScreened)
        candidates = c.lenientArray(.candidates, of: Candidate.self)
    }
}

/// A nested token descriptor on a candidate ({ symbol, mint, organic, warnings }).
struct CandidateToken: Codable, Sendable, Equatable {
    var symbol: String? = nil
    var mint: String? = nil
    var organic: Double? = nil
    var warnings: Int? = nil

    enum CodingKeys: String, CodingKey { case symbol, mint, organic, warnings }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        symbol = c.lenientString(.symbol)
        mint = c.lenientString(.mint)
        organic = c.lenientDouble(.organic)
        warnings = c.lenientInt(.warnings)
    }
}

/// Maps to normalizeCandidateForUi() / condensePool() output.
struct Candidate: Codable, Sendable, Equatable, Identifiable {
    var pool: String? = nil
    var name: String? = nil
    var base: CandidateToken? = nil
    var quote: CandidateToken? = nil
    var poolType: String? = nil
    var binStep: Int? = nil
    var feePct: Double? = nil
    var activeTvl: Double? = nil
    var volume: Double? = nil
    var fee: Double? = nil
    var feeActiveTvlRatio: Double? = nil
    var feeTvlRatio: Double? = nil
    var swapCount: Int? = nil
    var volatility: Double? = nil
    var holders: Int? = nil
    var mcap: Double? = nil
    var organicScore: Double? = nil
    var activePositions: Int? = nil
    var activePct: Double? = nil
    var openPositions: Int? = nil
    var price: Double? = nil
    var priceChangePct: Double? = nil
    var priceTrend: String? = nil
    var minPrice: Double? = nil
    var maxPrice: Double? = nil

    var id: String { pool ?? name ?? UUID().uuidString }

    enum CodingKeys: String, CodingKey {
        case pool, name, base, quote
        case poolType = "pool_type"
        case binStep = "bin_step"
        case feePct = "fee_pct"
        case activeTvl = "active_tvl"
        case volume, fee
        case feeActiveTvlRatio = "fee_active_tvl_ratio"
        case feeTvlRatio = "fee_tvl_ratio"
        case swapCount = "swap_count"
        case volatility, holders, mcap
        case organicScore = "organic_score"
        case activePositions = "active_positions"
        case activePct = "active_pct"
        case openPositions = "open_positions"
        case price
        case priceChangePct = "price_change_pct"
        case priceTrend = "price_trend"
        case minPrice = "min_price"
        case maxPrice = "max_price"
    }

    init() {}

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        pool = c.lenientString(.pool)
        name = c.lenientString(.name)
        base = c.lenientObject(.base, of: CandidateToken.self)
        quote = c.lenientObject(.quote, of: CandidateToken.self)
        poolType = c.lenientString(.poolType)
        binStep = c.lenientInt(.binStep)
        feePct = c.lenientDouble(.feePct)
        activeTvl = c.lenientDouble(.activeTvl)
        volume = c.lenientDouble(.volume)
        fee = c.lenientDouble(.fee)
        feeActiveTvlRatio = c.lenientDouble(.feeActiveTvlRatio)
        feeTvlRatio = c.lenientDouble(.feeTvlRatio)
        swapCount = c.lenientInt(.swapCount)
        volatility = c.lenientDouble(.volatility)
        holders = c.lenientInt(.holders)
        mcap = c.lenientDouble(.mcap)
        organicScore = c.lenientDouble(.organicScore)
        activePositions = c.lenientInt(.activePositions)
        activePct = c.lenientDouble(.activePct)
        openPositions = c.lenientInt(.openPositions)
        price = c.lenientDouble(.price)
        priceChangePct = c.lenientDouble(.priceChangePct)
        priceTrend = c.lenientString(.priceTrend)
        minPrice = c.lenientDouble(.minPrice)
        maxPrice = c.lenientDouble(.maxPrice)
    }

    /// Best available fee/TVL ratio (server uses either field name).
    var bestFeeTvlRatio: Double? { feeActiveTvlRatio ?? feeTvlRatio }
}

// MARK: - Status / Timers

/// Maps to "status" message + the status block of "init".
/// { busy, managementBusy, screeningBusy }
struct StatusInfo: Codable, Sendable, Equatable {
    var busy: Bool? = nil
    var managementBusy: Bool? = nil
    var screeningBusy: Bool? = nil

    enum CodingKeys: String, CodingKey {
        case busy, managementBusy, screeningBusy
    }

    init(busy: Bool? = nil, managementBusy: Bool? = nil, screeningBusy: Bool? = nil) {
        self.busy = busy
        self.managementBusy = managementBusy
        self.screeningBusy = screeningBusy
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        busy = c.lenientBool(.busy)
        managementBusy = c.lenientBool(.managementBusy)
        screeningBusy = c.lenientBool(.screeningBusy)
    }

    /// True if anything is busy (used for an activity spinner).
    var isAnyBusy: Bool {
        (busy ?? false) || (managementBusy ?? false) || (screeningBusy ?? false)
    }
}

/// Maps to "timer" message + the timers block of "init".
/// { management:"...", screening:"..." } — formatted countdown strings.
struct Timers: Codable, Sendable, Equatable {
    var management: String? = nil
    var screening: String? = nil

    enum CodingKeys: String, CodingKey { case management, screening }

    init(management: String? = nil, screening: String? = nil) {
        self.management = management
        self.screening = screening
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        management = c.lenientString(.management)
        screening = c.lenientString(.screening)
    }
}

// MARK: - Notifications & Chat

/// Maps to "notification": { event, data }.
/// event ∈ deploy|close|out_of_range|briefing|cycle:management|cycle:screening
struct NotificationMsg: Codable, Sendable, Equatable {
    var event: String? = nil
    var data: AnyJSON? = nil

    enum CodingKeys: String, CodingKey { case event, data }

    init(event: String? = nil, data: AnyJSON? = nil) {
        self.event = event
        self.data = data
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        event = c.lenientString(.event)
        data = c.lenientObject(.data, of: AnyJSON.self)
    }
}

/// Maps to "chat:response": { text, ts }.
struct ChatMessage: Codable, Sendable, Equatable {
    var text: String? = nil
    var ts: String? = nil

    enum CodingKeys: String, CodingKey { case text, ts }

    init(text: String? = nil, ts: String? = nil) {
        self.text = text
        self.ts = ts
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        text = c.lenientString(.text)
        ts = c.lenientString(.ts)
    }
}

// MARK: - Init payload

/// Maps to the "init" message:
/// { authed, authRequired, status, history, timers, positions, wallet, candidates, lpOverview }
struct InitPayload: Codable, Sendable, Equatable {
    var authed: Bool? = nil
    var authRequired: Bool? = nil
    var status: StatusInfo? = nil
    var history: [AnyJSON] = []
    var timers: Timers? = nil
    var positions: PositionsPayload? = nil
    var wallet: Wallet? = nil
    var candidates: CandidatesPayload? = nil

    enum CodingKeys: String, CodingKey {
        case authed, authRequired, status, history, timers, positions, wallet, candidates
    }

    init() {}

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else { return }
        authed = c.lenientBool(.authed)
        authRequired = c.lenientBool(.authRequired)
        status = c.lenientObject(.status, of: StatusInfo.self)
        history = c.lenientArray(.history, of: AnyJSON.self)
        timers = c.lenientObject(.timers, of: Timers.self)
        positions = c.lenientObject(.positions, of: PositionsPayload.self)
        wallet = c.lenientObject(.wallet, of: Wallet.self)
        candidates = c.lenientObject(.candidates, of: CandidatesPayload.self)
    }
}

// MARK: - App-side view models (not directly from the wire)

/// A single entry in the Activity log (newest first). Derived from notifications.
struct ActivityEntry: Identifiable, Sendable, Equatable {
    let id = UUID()
    var event: String
    var title: String
    var detail: String?
    var timestamp: Date

    init(event: String, title: String, detail: String? = nil, timestamp: Date = Date()) {
        self.event = event
        self.title = title
        self.detail = detail
        self.timestamp = timestamp
    }
}

/// A single line in the Chat tab.
struct ChatLine: Identifiable, Sendable, Equatable {
    enum Role: String, Sendable { case user, agent, system }
    let id = UUID()
    var role: Role
    var text: String
    var timestamp: Date

    init(role: Role, text: String, timestamp: Date = Date()) {
        self.role = role
        self.text = text
        self.timestamp = timestamp
    }
}
