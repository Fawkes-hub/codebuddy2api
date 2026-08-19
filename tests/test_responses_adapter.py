import unittest

from src.responses_adapter import (
    ResponsesAdapterError,
    chat_sse_to_responses,
    chat_to_response,
    responses_to_chat,
)


class ResponsesRequestAdapterTests(unittest.TestCase):
    def test_text_request_maps_to_chat_messages_and_options(self):
        converted = responses_to_chat({
            "model": "deepseek-v4-flash",
            "input": "hello",
            "instructions": "be concise",
            "max_output_tokens": 32,
            "reasoning": {"effort": "high"},
        })

        self.assertEqual(converted["model"], "deepseek-v4-flash")
        self.assertEqual(converted["messages"], [
            {"role": "system", "content": "be concise"},
            {"role": "user", "content": "hello"},
        ])
        self.assertEqual(converted["max_tokens"], 32)
        self.assertEqual(converted["reasoning_effort"], "high")
        self.assertFalse(converted["stream"])

    def test_input_items_and_function_tools_are_converted(self):
        converted = responses_to_chat({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "find it"}],
            }],
            "tools": [{
                "type": "function",
                "name": "lookup",
                "description": "look up data",
                "parameters": {"type": "object"},
            }],
            "tool_choice": {"type": "function", "name": "lookup"},
        })

        self.assertEqual(converted["messages"][0]["content"], "find it")
        self.assertEqual(converted["tools"][0]["function"]["name"], "lookup")
        self.assertEqual(converted["tool_choice"]["function"]["name"], "lookup")

    def test_unsupported_state_and_visual_input_fail_explicitly(self):
        cases = [
            {"input": "hello", "previous_response_id": "resp_1"},
            {"input": [{"type": "input_image", "image_url": "x"}]},
        ]
        for body in cases:
            with self.subTest(body=body):
                with self.assertRaises(ResponsesAdapterError):
                    responses_to_chat(body)


class ResponsesResponseAdapterTests(unittest.IsolatedAsyncioTestCase):
    def test_chat_response_maps_to_response_envelope(self):
        converted = chat_to_response({
            "id": "chatcmpl-1",
            "created": 123,
            "model": "deepseek-v4-flash",
            "choices": [{
                "message": {"role": "assistant", "content": "answer"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5},
        }, "resp_1")

        self.assertEqual(converted["id"], "resp_1")
        self.assertEqual(converted["object"], "response")
        self.assertEqual(converted["output_text"], "answer")
        self.assertEqual(converted["usage"]["input_tokens"], 2)
        self.assertEqual(converted["output"][0]["content"][0]["text"], "answer")

    async def test_chat_sse_maps_text_delta_and_completion_events(self):
        async def chunks():
            yield 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
            yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            yield 'data: [DONE]\n\n'

        output = [item async for item in chat_sse_to_responses(chunks(), "resp_1", "model")]
        text = "".join(output)

        self.assertIn('"type": "response.output_text.delta"', text)
        self.assertIn('"delta": "hi"', text)
        self.assertIn('"type": "response.completed"', text)


if __name__ == "__main__":
    unittest.main()
