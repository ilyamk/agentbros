"""Hermetic tokenizer guard tests; no ML packages, network or inference claim."""

from __future__ import annotations

import importlib.util
import pathlib
import unittest
from types import SimpleNamespace

worker = pathlib.Path(__file__).parents[2] / "scripts/workers/local-analysis.py"
spec = importlib.util.spec_from_file_location("local_analysis", worker)
assert spec is not None
assert spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeTokenizer:
    def __init__(self) -> None:
        self.calls = []
        self.example_attribute = "retained"

    def __call__(self, texts: list[str], **kwargs: object) -> dict[str, list[list[str]]]:
        self.calls.append((texts, kwargs))
        tokens = [[*list(text), "START", "END"] for text in texts]
        if kwargs.get("truncation"):
            limit = kwargs["max_length"]
            assert isinstance(limit, int)
            tokens = [row[:limit] for row in tokens]
        return {"input_ids": tokens}


class WindowTests(unittest.TestCase):
    def test_effective_strip_lowercase_and_special_tokens(self) -> None:
        raw = FakeTokenizer()
        checked = module.WindowCheckedTokenizer(raw, 5)

        def preprocess(texts: list[str]) -> dict[str, list[list[str]]]:
            return checked([text.strip().lower() for text in texts], truncation="longest_first", max_length=5, padding=True, return_tensors="pt")

        self.assertEqual(len(preprocess(["  a  "])["input_ids"][0]), 3)
        self.assertEqual(raw.calls[-1][1]["return_tensors"], "pt")
        self.assertFalse(raw.calls[0][1]["truncation"])
        self.assertNotIn("max_length", raw.calls[0][1])
        self.assertEqual(checked.example_attribute, "retained")
        # Lowercasing expands U+0130: raw input fits, effective input does not.
        with self.assertRaisesRegex(ValueError, "sequence window"):
            preprocess(["İİ"])
        self.assertFalse(raw.calls[-1][1]["truncation"])
        with self.assertRaisesRegex(ValueError, "sequence window"):
            preprocess(["a", "abcd"])

    def test_default_prompt_rejected_before_tokenizer_or_encode(self) -> None:
        first = SimpleNamespace(tokenizer=FakeTokenizer())
        model = SimpleNamespace(default_prompt_name="retrieval", _first_module=lambda: first, max_seq_length=5)
        with self.assertRaisesRegex(ValueError, "configured default prompt"):
            module.guard_embedding_model(model)
        self.assertIsInstance(first.tokenizer, FakeTokenizer)
        model.default_prompt_name = None
        module.guard_embedding_model(model)
        self.assertIsInstance(first.tokenizer, module.WindowCheckedTokenizer)


if __name__ == "__main__":
    unittest.main()
