package farm.ballydidean.weather.widget

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

internal sealed interface JsonValue
internal data class JsonObject(val values: Map<String, JsonValue>) : JsonValue
internal data class JsonArray(val values: List<JsonValue>) : JsonValue
internal data class JsonString(val value: String) : JsonValue
internal data class JsonNumber(val value: Double) : JsonValue
internal data class JsonBoolean(val value: Boolean) : JsonValue
internal data object JsonNull : JsonValue

internal object StrictJson {
    // decode strict utf-8 and json
    fun parse(bytes: ByteArray): JsonValue {
        val decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        val text = try {
            decoder.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (error: java.nio.charset.CharacterCodingException) {
            throw IllegalArgumentException("json is not valid utf-8", error)
        }
        return Parser(text).parse()
    }

    private class Parser(private val input: String) {
        private var offset = 0
        private var nodes = 0

        // consume exactly one json value
        fun parse(): JsonValue {
            skipWhitespace()
            val value = parseValue(0)
            skipWhitespace()
            require(offset == input.length) { "unexpected trailing json" }
            return value
        }

        // select the next json production
        private fun parseValue(depth: Int): JsonValue {
            require(depth <= MAX_DEPTH) { "json nesting is too deep" }
            nodes++
            require(nodes <= MAX_NODES) { "json has too many values" }
            require(offset < input.length) { "unexpected end of json" }
            return when (input[offset]) {
                '{' -> parseObject(depth)
                '[' -> parseArray(depth)
                '"' -> JsonString(parseString())
                't' -> parseLiteral("true", JsonBoolean(true))
                'f' -> parseLiteral("false", JsonBoolean(false))
                'n' -> parseLiteral("null", JsonNull)
                '-', in '0'..'9' -> parseNumber()
                else -> throw IllegalArgumentException("invalid json token")
            }
        }

        // reject duplicate object members
        private fun parseObject(depth: Int): JsonObject {
            expect('{')
            skipWhitespace()
            val values = linkedMapOf<String, JsonValue>()
            // accept an empty object
            if (consume('}')) {
                return JsonObject(values)
            }
            // read every unique member
            while (true) {
                require(peek() == '"') { "object key must be a string" }
                val key = parseString()
                require(key !in values) { "duplicate json member" }
                skipWhitespace()
                expect(':')
                skipWhitespace()
                values[key] = parseValue(depth + 1)
                skipWhitespace()
                // finish after the last member
                if (consume('}')) {
                    return JsonObject(values)
                }
                expect(',')
                skipWhitespace()
            }
        }

        // parse each array member
        private fun parseArray(depth: Int): JsonArray {
            expect('[')
            skipWhitespace()
            val values = mutableListOf<JsonValue>()
            // accept an empty array
            if (consume(']')) {
                return JsonArray(values)
            }
            // read through the closing bracket
            while (true) {
                values += parseValue(depth + 1)
                skipWhitespace()
                // finish after the last member
                if (consume(']')) {
                    return JsonArray(values)
                }
                expect(',')
                skipWhitespace()
            }
        }

        // decode json escapes and unicode pairs
        private fun parseString(): String {
            expect('"')
            val output = StringBuilder()
            // scan through the matching quote
            while (offset < input.length) {
                val character = input[offset++]
                // return at the string terminator
                if (character == '"') {
                    return output.toString()
                }
                require(character.code >= 0x20) { "control character in string" }
                // copy ordinary characters directly
                if (character != '\\') {
                    output.append(character)
                    continue
                }
                require(offset < input.length) { "unterminated escape" }
                when (val escape = input[offset++]) {
                    '"', '\\', '/' -> output.append(escape)
                    'b' -> output.append('\b')
                    'f' -> output.append('\u000c')
                    'n' -> output.append('\n')
                    'r' -> output.append('\r')
                    't' -> output.append('\t')
                    'u' -> appendUnicode(output)
                    else -> throw IllegalArgumentException("invalid string escape")
                }
            }
            throw IllegalArgumentException("unterminated string")
        }

        // preserve valid unicode scalar values
        private fun appendUnicode(output: StringBuilder) {
            val first = readCodeUnit()
            // pair a leading surrogate
            if (first in 0xD800..0xDBFF) {
                require(offset + 1 < input.length && input[offset] == '\\' && input[offset + 1] == 'u') {
                    "missing low surrogate"
                }
                offset += 2
                val second = readCodeUnit()
                require(second in 0xDC00..0xDFFF) { "invalid low surrogate" }
                output.appendCodePoint(Character.toCodePoint(first.toChar(), second.toChar()))
                return
            }
            require(first !in 0xDC00..0xDFFF) { "unexpected low surrogate" }
            output.append(first.toChar())
        }

        // read four hexadecimal digits
        private fun readCodeUnit(): Int {
            require(offset + 4 <= input.length) { "short unicode escape" }
            val digits = input.substring(offset, offset + 4)
            require(digits.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) { "invalid unicode escape" }
            offset += 4
            return digits.toInt(16)
        }

        // enforce the json number grammar
        private fun parseNumber(): JsonNumber {
            val start = offset
            consume('-')
            require(offset < input.length) { "short number" }
            // reject leading zeroes
            if (consume('0')) {
                require(offset >= input.length || input[offset] !in '0'..'9') { "leading zero" }
            } else {
                require(input[offset] in '1'..'9') { "invalid number" }
                // consume the integer digits
                while (offset < input.length && input[offset] in '0'..'9') {
                    offset++
                }
            }
            // consume an optional fraction
            if (consume('.')) {
                require(offset < input.length && input[offset] in '0'..'9') { "empty fraction" }
                while (offset < input.length && input[offset] in '0'..'9') {
                    offset++
                }
            }
            // consume an optional exponent
            if (offset < input.length && input[offset].lowercaseChar() == 'e') {
                offset++
                // accept one optional sign
                if (offset < input.length && input[offset] in listOf('+', '-')) {
                    offset++
                }
                require(offset < input.length && input[offset] in '0'..'9') { "empty exponent" }
                while (offset < input.length && input[offset] in '0'..'9') {
                    offset++
                }
            }
            val number = input.substring(start, offset).toDouble()
            require(number.isFinite()) { "non-finite number" }
            return JsonNumber(number)
        }

        // consume one fixed literal
        private fun parseLiteral(literal: String, value: JsonValue): JsonValue {
            require(input.startsWith(literal, offset)) { "invalid literal" }
            offset += literal.length
            return value
        }

        // skip json whitespace only
        private fun skipWhitespace() {
            while (offset < input.length && input[offset] in listOf(' ', '\t', '\r', '\n')) {
                offset++
            }
        }

        // require one punctuation character
        private fun expect(character: Char) {
            require(consume(character)) { "expected $character" }
        }

        // consume one matching character
        private fun consume(character: Char): Boolean {
            // advance only on a match
            if (offset < input.length && input[offset] == character) {
                offset++
                return true
            }
            return false
        }

        // inspect without consuming
        private fun peek(): Char? = input.getOrNull(offset)

        companion object {
            private const val MAX_DEPTH = 32
            private const val MAX_NODES = 10_000
        }
    }
}

// require one exact closed object shape
internal fun JsonValue.closedObject(keys: Set<String>, label: String): JsonObject {
    val objectValue = this as? JsonObject ?: throw IllegalArgumentException("$label must be an object")
    require(objectValue.values.keys == keys) { "$label has unexpected members" }
    return objectValue
}

// require one string member
internal fun JsonObject.string(name: String): String =
    (values[name] as? JsonString)?.value ?: throw IllegalArgumentException("$name must be a string")

// require one finite number member
internal fun JsonObject.number(name: String): Double =
    (values[name] as? JsonNumber)?.value ?: throw IllegalArgumentException("$name must be a number")

// require one array member
internal fun JsonObject.array(name: String): List<JsonValue> =
    (values[name] as? JsonArray)?.values ?: throw IllegalArgumentException("$name must be an array")

// require one object member
internal fun JsonObject.objectValue(name: String): JsonObject =
    values[name] as? JsonObject ?: throw IllegalArgumentException("$name must be an object")
