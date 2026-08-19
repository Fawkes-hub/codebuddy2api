"""将 OpenAI Responses 协议适配到现有 Chat Completions 服务。"""
import json
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import HTTPException

from .sse import SSE_DONE, SSEDataError, format_sse_event, iter_sse_events


class ResponsesAdapterError(HTTPException):
    """Responses 请求无法安全转换为 Chat Completions 请求。"""

    def __init__(self, detail: str):
        super().__init__(status_code=400, detail=detail)


def _unsupported(field: str) -> None:
    raise ResponsesAdapterError(f"Responses field is not supported yet: {field}")


def _content_to_text(content: Any) -> Any:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        raise ResponsesAdapterError("message.content must be a string or an array")
    parts: List[str] = []
    for part in content:
        if not isinstance(part, dict):
            raise ResponsesAdapterError("message.content items must be objects")
        part_type = part.get("type")
        if part_type in {"input_text", "output_text", "text"}:
            text = part.get("text")
            if isinstance(text, str):
                parts.append(text)
                continue
        if part_type in {"input_image", "image_url", "input_file", "file"}:
            _unsupported(f"input content type {part_type}")
        raise ResponsesAdapterError(f"Unsupported message content type: {part_type}")
    return "".join(parts)


def _function_output_to_text(output: Any) -> str:
    if isinstance(output, str):
        return output
    return json.dumps(output, ensure_ascii=False, separators=(",", ":"))


def _input_to_messages(value: Any) -> List[Dict[str, Any]]:
    if isinstance(value, str):
        return [{"role": "user", "content": value}]
    if not isinstance(value, list) or not value:
        raise ResponsesAdapterError("input must be a non-empty string or array")

    messages: List[Dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            raise ResponsesAdapterError("input items must be objects")
        item_type = item.get("type", "message")
        if item_type == "message":
            role = item.get("role")
            if not isinstance(role, str) or not role:
                raise ResponsesAdapterError("message items require a role")
            messages.append({"role": role, "content": _content_to_text(item.get("content", ""))})
            continue
        if item_type == "function_call_output":
            call_id = item.get("call_id")
            if not isinstance(call_id, str) or not call_id:
                raise ResponsesAdapterError("function_call_output requires call_id")
            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "content": _function_output_to_text(item.get("output", "")),
            })
            continue
        if item_type == "function_call":
            call_id = item.get("call_id") or item.get("id")
            name = item.get("name")
            if not isinstance(call_id, str) or not isinstance(name, str):
                raise ResponsesAdapterError("function_call requires call_id and name")
            messages.append({
                "role": "assistant",
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": str(item.get("arguments", ""))},
                }],
            })
            continue
        raise ResponsesAdapterError(f"Unsupported input item type: {item_type}")
    return messages


def _tools_to_chat(tools: Any) -> Any:
    if tools is None:
        return None
    if not isinstance(tools, list):
        raise ResponsesAdapterError("tools must be an array")
    converted = []
    for tool in tools:
        if not isinstance(tool, dict) or tool.get("type") != "function":
            _unsupported("non-function tools")
        function = tool.get("function")
        if isinstance(function, dict):
            converted.append({"type": "function", "function": function.copy()})
            continue
        name = tool.get("name")
        if not isinstance(name, str) or not name:
            raise ResponsesAdapterError("function tools require name")
        converted.append({
            "type": "function",
            "function": {
                "name": name,
                "description": tool.get("description", ""),
                "parameters": tool.get("parameters", {}),
            },
        })
    return converted


def _tool_choice_to_chat(tool_choice: Any) -> Any:
    if tool_choice is None or isinstance(tool_choice, str):
        return tool_choice
    if isinstance(tool_choice, dict) and tool_choice.get("type") == "function":
        name = tool_choice.get("name")
        if not name and isinstance(tool_choice.get("function"), dict):
            name = tool_choice["function"].get("name")
        if isinstance(name, str) and name:
            return {"type": "function", "function": {"name": name}}
    raise ResponsesAdapterError("Unsupported tool_choice format")


def responses_to_chat(request_body: Dict[str, Any]) -> Dict[str, Any]:
    """将 Responses 请求转换为现有 Chat Completions 请求。"""
    if not isinstance(request_body, dict):
        raise ResponsesAdapterError("Request body must be a JSON object")
    if request_body.get("previous_response_id"):
        _unsupported("previous_response_id")
    if "conversation" in request_body:
        _unsupported("conversation")
    if "input" not in request_body:
        raise ResponsesAdapterError("input is required")

    messages = _input_to_messages(request_body["input"])
    instructions = request_body.get("instructions")
    if instructions is not None:
        if not isinstance(instructions, str):
            raise ResponsesAdapterError("instructions must be a string")
        messages.insert(0, {"role": "system", "content": instructions})

    chat: Dict[str, Any] = {
        "model": request_body.get("model"),
        "messages": messages,
        "stream": bool(request_body.get("stream", False)),
    }
    for field in ("temperature", "top_p", "response_format", "parallel_tool_calls"):
        if field in request_body:
            chat[field] = request_body[field]
    max_tokens = request_body.get("max_output_tokens", request_body.get("max_tokens"))
    if max_tokens is not None:
        chat["max_tokens"] = max_tokens
    reasoning = request_body.get("reasoning")
    if isinstance(reasoning, dict) and reasoning.get("effort") is not None:
        chat["reasoning_effort"] = reasoning["effort"]
    tools = _tools_to_chat(request_body.get("tools"))
    if tools is not None:
        chat["tools"] = tools
    tool_choice = _tool_choice_to_chat(request_body.get("tool_choice"))
    if tool_choice is not None:
        chat["tool_choice"] = tool_choice
    return chat


def new_response_id() -> str:
    return f"resp_{uuid.uuid4().hex}"


def _usage_to_responses(usage: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(usage, dict):
        return None
    return {
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
        "total_tokens": usage.get("total_tokens", 0),
    }


def chat_to_response(chat_response: Dict[str, Any], response_id: str) -> Dict[str, Any]:
    """将 Chat Completions 非流式响应转换为 Responses 响应。"""
    choices = chat_response.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices else {}
    message = choice.get("message", {}) if isinstance(choice, dict) else {}
    output: List[Dict[str, Any]] = []
    content = message.get("content", "") if isinstance(message, dict) else ""
    if isinstance(content, str):
        output.append({
            "type": "message",
            "id": f"msg_{uuid.uuid4().hex}",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": content, "annotations": []}],
        })
    tool_calls = message.get("tool_calls", []) if isinstance(message, dict) else []
    for tool_call in tool_calls:
        function = tool_call.get("function", {})
        output.append({
            "type": "function_call",
            "id": tool_call.get("id") or f"fc_{uuid.uuid4().hex}",
            "call_id": tool_call.get("id") or f"call_{uuid.uuid4().hex}",
            "name": function.get("name", ""),
            "arguments": function.get("arguments", ""),
            "status": "completed",
        })
    text = content if isinstance(content, str) else ""
    response = {
        "id": response_id,
        "object": "response",
        "created_at": chat_response.get("created", 0),
        "status": "completed",
        "model": chat_response.get("model", "unknown"),
        "output": output,
        "output_text": text,
    }
    usage = _usage_to_responses(chat_response.get("usage"))
    if usage is not None:
        response["usage"] = usage
    return response


def _response_event(event_type: str, sequence_number: int, **fields: Any) -> str:
    return format_sse_event({"type": event_type, "sequence_number": sequence_number, **fields})


async def chat_sse_to_responses(
        chunks: AsyncIterator[Any],
        response_id: str,
        model: str,
) -> AsyncIterator[str]:
    """将现有 Chat SSE 转换为 Responses SSE，覆盖文本和函数调用输出。"""
    sequence = 0
    text = ""
    usage = None
    tool_calls: Dict[int, Dict[str, Any]] = {}
    item_started = False
    content_started = False
    message_id = f"msg_{uuid.uuid4().hex}"
    yield _response_event("response.created", sequence, response={"id": response_id, "object": "response", "status": "in_progress", "model": model, "output": []})
    sequence += 1
    yield _response_event("response.in_progress", sequence, response={"id": response_id, "object": "response", "status": "in_progress", "model": model, "output": []})
    sequence += 1

    async def text_chunks() -> AsyncIterator[str]:
        async for chunk in chunks:
            if isinstance(chunk, bytes):
                yield chunk.decode("utf-8", errors="replace")
            else:
                yield str(chunk)

    try:
        async for event in iter_sse_events(text_chunks()):
            if event is SSE_DONE:
                break
            if not isinstance(event, dict):
                continue
            if "error" in event:
                yield _response_event("response.failed", sequence, response={"id": response_id, "object": "response", "status": "failed", "error": event["error"]})
                return
            if isinstance(event.get("usage"), dict):
                usage = _usage_to_responses(event["usage"])
            choices = event.get("choices")
            choice = choices[0] if isinstance(choices, list) and choices else {}
            delta = choice.get("delta", {}) if isinstance(choice, dict) else {}
            if not isinstance(delta, dict):
                continue
            content = delta.get("content")
            if isinstance(content, str) and content:
                if not item_started:
                    item_started = True
                    yield _response_event("response.output_item.added", sequence, output_index=0, item={"type": "message", "id": message_id, "status": "in_progress", "role": "assistant", "content": []})
                    sequence += 1
                if not content_started:
                    content_started = True
                    yield _response_event("response.content_part.added", sequence, item_id=message_id, output_index=0, content_index=0, part={"type": "output_text", "text": "", "annotations": []})
                    sequence += 1
                text += content
                yield _response_event("response.output_text.delta", sequence, item_id=message_id, output_index=0, content_index=0, delta=content, logprobs=[])
                sequence += 1
            for tool_call in delta.get("tool_calls", []) if isinstance(delta.get("tool_calls"), list) else []:
                index = tool_call.get("index", 0)
                current = tool_calls.setdefault(index, {"type": "function_call", "id": tool_call.get("id"), "call_id": tool_call.get("id"), "name": "", "arguments": "", "status": "in_progress"})
                function = tool_call.get("function", {})
                if function.get("name"):
                    current["name"] = function["name"]
                arguments = function.get("arguments", "")
                if arguments:
                    current["arguments"] += arguments
                    if not item_started:
                        item_started = True
                        yield _response_event("response.output_item.added", sequence, output_index=index, item=current.copy())
                        sequence += 1
                    yield _response_event("response.function_call_arguments.delta", sequence, item_id=current.get("id"), output_index=index, delta=arguments)
                    sequence += 1
    except SSEDataError as error:
        yield _response_event("response.failed", sequence, response={"id": response_id, "object": "response", "status": "failed", "error": {"message": str(error), "type": "upstream_protocol_error"}})
        return

    output: List[Dict[str, Any]] = []
    if text:
        if content_started:
            yield _response_event("response.output_text.done", sequence, item_id=message_id, output_index=0, content_index=0, text=text)
            sequence += 1
            yield _response_event("response.content_part.done", sequence, item_id=message_id, output_index=0, content_index=0, part={"type": "output_text", "text": text, "annotations": []})
            sequence += 1
        output.append({"type": "message", "id": message_id, "status": "completed", "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]})
    for index, tool_call in sorted(tool_calls.items()):
        tool_call["status"] = "completed"
        yield _response_event("response.function_call_arguments.done", sequence, item_id=tool_call.get("id"), output_index=index, arguments=tool_call["arguments"])
        sequence += 1
        yield _response_event("response.output_item.done", sequence, output_index=index, item=tool_call.copy())
        sequence += 1
        output.append(tool_call.copy())
    if item_started and text:
        yield _response_event("response.output_item.done", sequence, output_index=0, item=output[0])
        sequence += 1
    response = {"id": response_id, "object": "response", "created_at": 0, "status": "completed", "model": model, "output": output, "output_text": text}
    if usage is not None:
        response["usage"] = usage
    yield _response_event("response.completed", sequence, response=response)
