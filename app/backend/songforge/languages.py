"""Language names, as YuE2 expects to read them.

YuE2 has no language field. The language travels as the first tag of the style
text, and the model was trained on names - "English", "Portuguese" - not on
ISO codes. SongForge's default used to be stored as "en", so every song from a
fresh install opened its prompt with the two letters "en" in the most heavily
weighted position, which told the model nothing.

Anything that is not a recognised code is passed through untouched: a user who
types "Brazilian Portuguese" or "Old Norse" knows what they mean.
"""
from __future__ import annotations

ISO_NAMES: dict[str, str] = {
    "ar": "Arabic", "bg": "Bulgarian", "ca": "Catalan", "cs": "Czech",
    "da": "Danish", "de": "German", "el": "Greek", "en": "English",
    "es": "Spanish", "et": "Estonian", "fi": "Finnish", "fr": "French",
    "he": "Hebrew", "hi": "Hindi", "hr": "Croatian", "hu": "Hungarian",
    "id": "Indonesian", "is": "Icelandic", "it": "Italian", "ja": "Japanese",
    "ko": "Korean", "lt": "Lithuanian", "lv": "Latvian", "ms": "Malay",
    "nb": "Norwegian", "nl": "Dutch", "no": "Norwegian", "pl": "Polish",
    "pt": "Portuguese", "ro": "Romanian", "ru": "Russian", "sk": "Slovak",
    "sl": "Slovenian", "sr": "Serbian", "sv": "Swedish", "th": "Thai",
    "tr": "Turkish", "uk": "Ukrainian", "vi": "Vietnamese",
    "zh": "Mandarin Chinese", "yue": "Cantonese",
}

DEFAULT_LANGUAGE = "English"


def language_name(value: str | None) -> str:
    """"en" -> "English"; a name, or anything unrecognised, comes back as typed.

    Region suffixes are dropped before the lookup, so "en-US" and "pt_BR" read
    as their language.
    """
    text = (value or "").strip()
    if not text:
        return ""
    code = text.replace("_", "-").split("-")[0].lower()
    # Only short tokens are treated as codes: "it" is Italian, but so short a
    # check must not turn a real word someone typed into a language.
    if len(text) <= 5 and code in ISO_NAMES:
        return ISO_NAMES[code]
    return text
