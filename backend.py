import sqlite3
import os
import re
import base64
import json
import sys
import datetime
import shutil
import urllib.parse

# Reconfigure stdout/stderr to UTF-8 to avoid UnicodeEncodeError on Windows
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

# Paths
home = os.path.expanduser("~")
conversations_dir = os.path.join(home, ".gemini", "antigravity-ide", "conversations")
brain_dir = os.path.join(home, ".gemini", "antigravity-ide", "brain")
annotations_dir = os.path.join(home, ".gemini", "antigravity-ide", "annotations")

if sys.platform == "win32":
    appdata = os.environ.get("APPDATA")
    if not appdata:
        appdata = os.path.join(home, "AppData", "Roaming")
    db_path = os.path.join(appdata, "Antigravity IDE", "User", "globalStorage", "state.vscdb")
elif sys.platform == "darwin":  # macOS
    db_path = os.path.join(home, "Library", "Application Support", "Antigravity IDE", "User", "globalStorage", "state.vscdb")
else:  # Linux / Unix
    config_home = os.environ.get("XDG_CONFIG_HOME")
    if not config_home:
        config_home = os.path.join(home, ".config")
    db_path = os.path.join(config_home, "Antigravity IDE", "User", "globalStorage", "state.vscdb")

def normalize_path(p):
    if not p:
        return ""
    p = p.replace('/', '\\')
    if len(p) >= 3 and p[0] == '\\' and p[1].isalpha() and p[2] == ':':
        p = p[1:]
    if len(p) > 3 and p.endswith('\\'):
        p = p.rstrip('\\')
    return p

def match_title(item_title, wanted_title):
    if not item_title or not wanted_title:
        return False
    item_t = item_title.strip().lower()
    wanted_t = wanted_title.strip().lower()
    # 1. Exact match or inclusion
    if item_t == wanted_t or item_t in wanted_t or wanted_t in item_t:
        return True
    # 2. Compare first 20 characters
    if len(item_t) >= 20 and len(wanted_t) >= 20:
        if item_t[:20] == wanted_t[:20]:
            return True
    # 3. Handle prefix matching for truncated titles
    if len(item_t) >= 15 and wanted_t.startswith(item_t[:15]):
        return True
    if len(wanted_t) >= 15 and item_t.startswith(wanted_t[:15]):
        return True
    return False

def decode_varint(data, pos):
    val = 0
    shift = 0
    while True:
        b = data[pos]
        pos += 1
        val |= (b & 0x7f) << shift
        if not (b & 0x80):
            break
        shift += 7
    return val, pos

def encode_varint(val):
    res = bytearray()
    while True:
        b = val & 0x7f
        val >>= 7
        if val > 0:
            res.append(b | 0x80)
        else:
            res.append(b)
            break
    return bytes(res)

def parse_inner_summary(inner_bytes):
    pos = 0
    title = ""
    created_at = 0
    updated_at = 0
    opened_at = 0
    workspaces = []
    while pos < len(inner_bytes):
        tag, pos = decode_varint(inner_bytes, pos)
        field_num = tag >> 3
        wire_type = tag & 0x07
        if wire_type == 2:
            length, pos = decode_varint(inner_bytes, pos)
            val = inner_bytes[pos:pos+length]
            pos += length
            if field_num == 1:
                title = val.decode('utf-8', errors='ignore')
            elif field_num in (3, 4, 6):
                try:
                    sub_pos = 0
                    sub_tag, sub_pos = decode_varint(val, sub_pos)
                    sub_val, sub_pos = decode_varint(val, sub_pos)
                    if field_num == 3:
                        created_at = sub_val
                    elif field_num == 4:
                        updated_at = sub_val
                    elif field_num == 6:
                        opened_at = sub_val
                except Exception:
                    pass
            elif field_num == 9:
                try:
                    text = val.decode('utf-8', errors='ignore')
                    uris = re.findall(r'file:///([^\s\x00-\x1f\x12\x1a\x08\x0a\x0b\x00]+)', text)
                    for uri in uris:
                        decoded = urllib.parse.unquote(uri)
                        normalized = normalize_path(decoded)
                        if normalized and normalized not in workspaces:
                            workspaces.append(normalized)
                except Exception:
                    pass
        else:
            if wire_type == 0:
                _, pos = decode_varint(inner_bytes, pos)
            elif wire_type == 1:
                pos += 8
            elif wire_type == 5:
                pos += 4
    return {
        "title": title,
        "created_at": created_at,
        "updated_at": updated_at,
        "opened_at": opened_at,
        "workspaces": workspaces
    }

def serialize_inner_summary(title, created_at, updated_at, opened_at):
    res = bytearray()
    title_bytes = title.encode('utf-8')
    res.extend(encode_varint((1 << 3) | 2))
    res.extend(encode_varint(len(title_bytes)))
    res.extend(title_bytes)
    
    for field_num, ts in [(3, created_at), (4, updated_at), (6, opened_at)]:
        if ts > 0:
            sub_msg = encode_varint((1 << 3) | 0) + encode_varint(ts)
            res.extend(encode_varint((field_num << 3) | 2))
            res.extend(encode_varint(len(sub_msg)))
            res.extend(sub_msg)
            
    return bytes(res)

def parse_trajectory_summaries_preservation(data):
    items = []
    pos = 0
    while pos < len(data):
        tag, pos = decode_varint(data, pos)
        field_num = tag >> 3
        wire_type = tag & 0x07
        
        if field_num == 1 and wire_type == 2:
            length, pos = decode_varint(data, pos)
            item_bytes = data[pos:pos+length]
            pos += length
            
            item_pos = 0
            uuid = ""
            inner_b64 = ""
            while item_pos < len(item_bytes):
                itag, item_pos = decode_varint(item_bytes, item_pos)
                ifield = itag >> 3
                iwire = itag & 0x07
                if iwire == 2:
                    ilength, item_pos = decode_varint(item_bytes, item_pos)
                    ival = item_bytes[item_pos:item_pos+ilength]
                    item_pos += ilength
                    if ifield == 1:
                        uuid = ival.decode('utf-8', errors='ignore')
                    elif ifield == 2:
                        sub_pos = 0
                        while sub_pos < len(ival):
                            sub_tag, sub_pos = decode_varint(ival, sub_pos)
                            sub_field = sub_tag >> 3
                            sub_wire = sub_tag & 0x07
                            if sub_field == 1 and sub_wire == 2:
                                sub_len, sub_pos = decode_varint(ival, sub_pos)
                                sub_val = ival[sub_pos:sub_pos+sub_len]
                                sub_pos += sub_len
                                inner_b64 = sub_val.decode('utf-8', errors='ignore')
            
            title = ""
            created_at = 0
            workspaces = []
            if inner_b64:
                try:
                    padding = len(inner_b64) % 4
                    if padding == 2:
                        inner_b64 += "=="
                    elif padding == 3:
                        inner_b64 += "="
                    inner_bytes = base64.b64decode(inner_b64)
                    inner_data = parse_inner_summary(inner_bytes)
                    title = inner_data["title"]
                    created_at = inner_data["created_at"]
                    workspaces = inner_data.get("workspaces", [])
                except Exception:
                    pass
            
            items.append({
                "uuid": uuid,
                "title": title,
                "created_at": created_at,
                "workspaces": workspaces,
                "raw_bytes": item_bytes
            })
    return items

def serialize_preserved_summaries(items):
    res = bytearray()
    for item in items:
        raw = item["raw_bytes"]
        res.extend(encode_varint((1 << 3) | 2))
        res.extend(encode_varint(len(raw)))
        res.extend(raw)
    return bytes(res)

def get_active_items():
    if not os.path.exists(db_path):
        return []
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';")
        row = cursor.fetchone()
        conn.close()
        if not row:
            return []
        val = row[0]
        decoded = base64.b64decode(val)
        return parse_trajectory_summaries_preservation(decoded)
    except Exception as e:
        print(f"Error reading DB: {e}", file=sys.stderr)
        return []

def save_active_items(items):
    if not os.path.exists(db_path):
        return False
    try:
        re_encoded = serialize_preserved_summaries(items)
        re_b64 = base64.b64encode(re_encoded).decode('utf-8')
        conn = sqlite3.connect(db_path, timeout=5.0)
        cursor = conn.cursor()
        cursor.execute("UPDATE ItemTable SET value = ? WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries';", (re_b64,))
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        print(f"Error writing DB: {e}", file=sys.stderr)
        return False

def get_size_and_count(uuid):
    file_count = 0
    total_size = 0
    
    brain_path = os.path.join(brain_dir, uuid)
    if os.path.isdir(brain_path):
        for dirpath, dirnames, filenames in os.walk(brain_path):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                try:
                    if os.path.exists(fp):
                        total_size += os.path.getsize(fp)
                        file_count += 1
                except OSError:
                    pass
                    
    if os.path.exists(conversations_dir):
        for f in os.listdir(conversations_dir):
            if f.startswith(uuid):
                fp = os.path.join(conversations_dir, f)
                try:
                    total_size += os.path.getsize(fp)
                    file_count += 1
                except OSError:
                    pass

    if os.path.exists(annotations_dir):
        for f in os.listdir(annotations_dir):
            if f.startswith(uuid):
                fp = os.path.join(annotations_dir, f)
                try:
                    total_size += os.path.getsize(fp)
                    file_count += 1
                except OSError:
                    pass
                    
    return total_size, file_count

def get_heuristic_title(uuid):
    transcript_path = os.path.join(brain_dir, uuid, ".system_generated", "logs", "transcript.jsonl")
    if os.path.exists(transcript_path):
        try:
            with open(transcript_path, 'r', encoding='utf-8') as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        data = json.loads(line)
                        if data.get("type") == "USER_INPUT":
                            content = data.get("content", "")
                            if content:
                                content = content.strip()
                                req_match = re.search(r'<USER_REQUEST>(.*?)</USER_REQUEST>', content, re.DOTALL)
                                if req_match:
                                    content = req_match.group(1).strip()
                                
                                lines = [l.strip() for l in content.split('\n') if l.strip()]
                                if lines:
                                    title = lines[0]
                                    if len(title) > 60:
                                        title = title[:60] + "..."
                                    return title
                    except Exception:
                        pass
        except Exception:
            pass

    task_path = os.path.join(brain_dir, uuid, "task.md")
    if os.path.exists(task_path):
        try:
            with open(task_path, 'r', encoding='utf-8') as f:
                first_line = f.readline()
                if first_line.startswith("#"):
                    title = first_line.replace("#", "").strip()
                    if title:
                        return title
        except Exception:
            pass

    brain_path = os.path.join(brain_dir, uuid)
    if os.path.exists(brain_path):
        try:
            mtime = os.path.getmtime(brain_path)
            dt = datetime.datetime.fromtimestamp(mtime)
            return f"Conversation ({dt.strftime('%b %d, %Y %H:%M')})"
        except Exception:
            pass

    return f"Unnamed Conversation ({uuid[:8]})"

def get_heuristic_workspaces(uuid):
    transcript_path = os.path.join(brain_dir, uuid, ".system_generated", "logs", "transcript.jsonl")
    workspaces = []
    if os.path.exists(transcript_path):
        try:
            with open(transcript_path, 'r', encoding='utf-8') as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        data = json.loads(line)
                        if data.get("type") == "USER_INPUT":
                            content = data.get("content", "")
                            
                            # Match workspace paths like: e:\Desktop\Remoat -> ...
                            ws_matches = re.findall(r'([a-zA-Z]:\\[^\-\>\n\r]+?)\s*(?:->|=)', content)
                            if ws_matches:
                                for ws in ws_matches:
                                    ws_clean = ws.strip().replace('\\\\', '\\')
                                    if ws_clean not in workspaces:
                                        workspaces.append(ws_clean)
                                        
                            # Match active document
                            doc_match = re.search(r'Active Document:\s*([a-zA-Z]:\\[^\n]+)', content)
                            if doc_match:
                                doc_path = doc_match.group(1).strip()
                                doc_path = re.sub(r'\s*\([^)]*\)', '', doc_path).strip()
                                doc_path = doc_path.replace('\\\\', '\\')
                                
                                matched_parent = False
                                for ws in workspaces:
                                    if doc_path.lower().startswith(ws.lower()):
                                        matched_parent = True
                                        break
                                        
                                if not matched_parent:
                                    dir_path = os.path.dirname(doc_path)
                                    if dir_path and dir_path not in workspaces:
                                        workspaces.append(dir_path)
                    except Exception:
                        pass
        except Exception:
            pass
            
    decoded_workspaces = []
    for ws in workspaces:
        try:
            decoded = urllib.parse.unquote(ws)
            normalized = normalize_path(decoded)
            if normalized and normalized not in decoded_workspaces:
                decoded_workspaces.append(normalized)
        except Exception:
            normalized = normalize_path(ws)
            if normalized and normalized not in decoded_workspaces:
                decoded_workspaces.append(normalized)
                
    return decoded_workspaces

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

def get_default_generic_title(uuid, created_at):
    if not created_at or created_at <= 0:
        return f"Conversation {uuid[:8]}"
    try:
        dt = datetime.datetime.fromtimestamp(created_at)
        month_str = MONTHS[dt.month - 1]
        day_str = str(dt.day)
        return f"Conversation ({month_str} {day_str}) {uuid[:8]}"
    except Exception:
        return f"Conversation {uuid[:8]}"

def format_size(size_bytes):
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.2f} MB"

def serialize_item(uuid, title, created_at):
    inner_bytes = serialize_inner_summary(title, created_at, 0, 0)
    inner_b64 = base64.b64encode(inner_bytes).decode('utf-8')
    
    item = bytearray()
    uuid_bytes = uuid.encode('utf-8')
    item.extend(encode_varint((1 << 3) | 2))
    item.extend(encode_varint(len(uuid_bytes)))
    item.extend(uuid_bytes)
    
    sub_msg = bytearray()
    b64_bytes = inner_b64.encode('utf-8')
    sub_msg.extend(encode_varint((1 << 3) | 2))
    sub_msg.extend(encode_varint(len(b64_bytes)))
    sub_msg.extend(b64_bytes)
    
    item.extend(encode_varint((2 << 3) | 2))
    item.extend(encode_varint(len(sub_msg)))
    item.extend(sub_msg)
    
    return bytes(item)

def do_list(current_title_or_uuid=None):
    active_items = get_active_items()
    db_updated = False
    
    curr_uuid = None
    curr_title_lower = None
    if current_title_or_uuid:
        # Check if it's a UUID
        if re.match(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', current_title_or_uuid):
            curr_uuid = current_title_or_uuid.lower()
        else:
            curr_title_lower = current_title_or_uuid.strip().lower()
            
    # Identify all UUIDs on disk
    brain_uuids = []
    if os.path.exists(brain_dir):
        for name in os.listdir(brain_dir):
            if os.path.isdir(os.path.join(brain_dir, name)):
                if re.match(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', name):
                    brain_uuids.append(name.lower())
                    
    conv_uuids = set()
    if os.path.exists(conversations_dir):
        for name in os.listdir(conversations_dir):
            match = re.match(r'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', name)
            if match:
                conv_uuids.add(match.group(1).lower())
                
    annot_uuids = set()
    if os.path.exists(annotations_dir):
        for name in os.listdir(annotations_dir):
            match = re.match(r'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', name)
            if match:
                annot_uuids.add(match.group(1).lower())

    all_disk_uuids = set(brain_uuids).union(conv_uuids).union(annot_uuids)
    
    # Merge lists
    merged = {}
    
    # Process active items
    for item in active_items:
        uuid = item["uuid"].lower()
        created_at = item["created_at"]
        raw_db_title = item.get("title", "")
        
        db_title = raw_db_title
        if not db_title or db_title.startswith("Conversation (") or db_title.startswith("Unnamed Conversation") or db_title.startswith("Unnamed conversation") or db_title.startswith("Conversation "):
            db_title = get_default_generic_title(uuid, created_at)
            
        title = raw_db_title
        if not title:
            title = get_heuristic_title(uuid)
            
        display_title = title
        is_generic = not raw_db_title or raw_db_title.startswith("Conversation (") or raw_db_title.startswith("Unnamed Conversation") or raw_db_title.startswith("Unnamed conversation") or raw_db_title.startswith("Conversation ")
        
        if is_generic:
            heuristic_title = get_heuristic_title(uuid)
            if heuristic_title and not (heuristic_title.startswith("Conversation (") or heuristic_title.startswith("Unnamed Conversation") or heuristic_title.startswith("Conversation ") or heuristic_title.startswith("Unnamed conversation")):
                display_title = heuristic_title
                # Auto-repair the title in the database
                title = heuristic_title
                item["title"] = heuristic_title
                item["raw_bytes"] = serialize_item(uuid, heuristic_title, created_at)
                db_updated = True

        created_at_str = ""
        if created_at > 0:
            created_at_str = datetime.datetime.fromtimestamp(created_at).strftime('%Y-%m-%d %H:%M:%S')
            
        size, file_count = get_size_and_count(uuid)
        
        workspaces = item.get("workspaces", [])
        if not workspaces:
            workspaces = get_heuristic_workspaces(uuid)

        merged[uuid] = {
            "uuid": uuid,
            "title": title, # Repaired or original DB title
            "dbTitle": db_title, # Title currently stored in DB (before repair in this run)
            "genericTitle": get_default_generic_title(uuid, created_at), # Generated generic title
            "displayTitle": display_title, # Human readable
            "isActive": True,
            "isCurrent": False,
            "created_at": created_at,
            "created_at_str": created_at_str,
            "size_bytes": size,
            "size_str": format_size(size),
            "file_count": file_count,
            "workspaces": workspaces,
            "note": get_dialogue_note(uuid)
        }
        
    if db_updated:
        save_active_items(active_items)
        
    # Process remaining disk items (orphaned)
    for uuid in all_disk_uuids:
        if uuid not in merged:
            title = get_heuristic_title(uuid)
            size, file_count = get_size_and_count(uuid)
            
            created_at = 0
            created_at_str = ""
            brain_path = os.path.join(brain_dir, uuid)
            if os.path.exists(brain_path):
                created_at = int(os.path.getctime(brain_path))
                created_at_str = datetime.datetime.fromtimestamp(created_at).strftime('%Y-%m-%d %H:%M:%S')
                
            merged[uuid] = {
                "uuid": uuid,
                "title": title,
                "dbTitle": "",
                "displayTitle": title,
                "isActive": False,
                "isCurrent": False,
                "created_at": created_at,
                "created_at_str": created_at_str,
                "size_bytes": size,
                "size_str": format_size(size),
                "file_count": file_count,
                "workspaces": get_heuristic_workspaces(uuid),
                "note": get_dialogue_note(uuid)
            }
            
    # Resolve curr_uuid if title was passed
    if curr_title_lower:
        matched_item = None
        # Exact title check (against both db title and display title)
        for item in merged.values():
            if (item["title"] and item["title"].strip().lower() == curr_title_lower) or \
               (item["displayTitle"] and item["displayTitle"].strip().lower() == curr_title_lower):
                matched_item = item
                break
        # Fuzzy match title check
        if not matched_item:
            for item in merged.values():
                if match_title(item["title"], curr_title_lower) or match_title(item["displayTitle"], curr_title_lower):
                    matched_item = item
                    break
        if matched_item:
            curr_uuid = matched_item["uuid"]

    # Mark current conversation
    if curr_uuid:
        if curr_uuid in merged:
            merged[curr_uuid]["isCurrent"] = True

    # If we had a current conversation title or UUID but couldn't find it in merged, add it
    if current_title_or_uuid and (not curr_uuid or curr_uuid not in merged):
        if not curr_uuid:
            curr_uuid = "current-conversation-placeholder"
        title = current_title_or_uuid if not curr_uuid.startswith("current-") else "Current Conversation (Текущий диалог)"
        size, file_count = get_size_and_count(curr_uuid) if not curr_uuid.startswith("current-") else (0, 0)
        
        merged[curr_uuid] = {
            "uuid": curr_uuid,
            "title": title,
            "dbTitle": "",
            "displayTitle": title,
            "isActive": True,
            "isCurrent": True,
            "created_at": int(datetime.datetime.now().timestamp()),
            "created_at_str": datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            "size_bytes": size,
            "size_str": format_size(size),
            "file_count": file_count,
            "workspaces": get_heuristic_workspaces(curr_uuid),
            "note": get_dialogue_note(curr_uuid)
        }
            
    return list(merged.values())

def do_delete(uuid, current_title_or_uuid=None):
    uuid = uuid.lower()
    
    curr_uuid = None
    if current_title_or_uuid:
        if re.match(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', current_title_or_uuid):
            curr_uuid = current_title_or_uuid.lower()
        else:
            curr_title_lower = current_title_or_uuid.strip().lower()
            active_items = get_active_items()
            for item in active_items:
                if match_title(item["title"], curr_title_lower):
                    curr_uuid = item["uuid"].lower()
                    break
            if not curr_uuid:
                brain_uuids = []
                if os.path.exists(brain_dir):
                    for name in os.listdir(brain_dir):
                        if os.path.isdir(os.path.join(brain_dir, name)):
                            if re.match(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', name):
                                brain_uuids.append(name.lower())
                for u in brain_uuids:
                    t = get_heuristic_title(u)
                    if match_title(t, curr_title_lower):
                        curr_uuid = u
                        break

    if curr_uuid and uuid == curr_uuid:
        return {"success": False, "error": "Cannot delete the current active conversation."}

    # 1. Pre-flight lock checks (Try renaming to verify no other process is locking them)
    locked_files = []
    
    # Check brain folder
    brain_path = os.path.join(brain_dir, uuid)
    if os.path.exists(brain_path):
        try:
            temp_brain = brain_path + ".lock_test"
            os.rename(brain_path, temp_brain)
            os.rename(temp_brain, brain_path)
        except Exception as e:
            locked_files.append(f"brain/{uuid} ({e})")
            
    # Check conversation files
    conv_files = []
    if os.path.exists(conversations_dir):
        for f in os.listdir(conversations_dir):
            if f.startswith(uuid):
                conv_files.append(os.path.join(conversations_dir, f))
                
    for fp in conv_files:
        try:
            temp_fp = fp + ".lock_test"
            os.rename(fp, temp_fp)
            os.rename(temp_fp, fp)
        except Exception as e:
            locked_files.append(f"conversations/{os.path.basename(fp)} ({e})")
            
    # Check annotation files
    annot_files = []
    if os.path.exists(annotations_dir):
        for f in os.listdir(annotations_dir):
            if f.startswith(uuid):
                annot_files.append(os.path.join(annotations_dir, f))
                
    for fp in annot_files:
        try:
            temp_fp = fp + ".lock_test"
            os.rename(fp, temp_fp)
            os.rename(temp_fp, fp)
        except Exception as e:
            locked_files.append(f"annotations/{os.path.basename(fp)} ({e})")

    if locked_files:
        locked_list = ", ".join(locked_files)
        error_msg = f"Некоторые файлы заблокированы процессами IDE: {locked_list}. Пожалуйста, закройте этот чат в IDE, выполните перезагрузку окна (Ctrl+R) и попробуйте удалить снова."
        return {
            "success": False,
            "error": error_msg,
            "db_updated": False,
            "freed_bytes": 0,
            "freed_str": "0 B",
            "errors": locked_files
        }

    # 2. Delete files since no locks were detected
    deleted_files = 0
    freed_bytes = 0
    errors = []
    
    if os.path.exists(brain_path):
        try:
            sz = 0
            for root, dirs, files in os.walk(brain_path):
                for f in files:
                    fp = os.path.join(root, f)
                    try:
                        sz += os.path.getsize(fp)
                    except OSError:
                        pass
            shutil.rmtree(brain_path)
            freed_bytes += sz
            deleted_files += 1
        except Exception as e:
            errors.append(f"Failed to delete brain folder: {e}")
            
    for fp in conv_files:
        if os.path.exists(fp):
            try:
                sz = os.path.getsize(fp)
                os.remove(fp)
                freed_bytes += sz
                deleted_files += 1
            except Exception as e:
                errors.append(f"Failed to delete conversation file {os.path.basename(fp)}: {e}")
                
    for fp in annot_files:
        if os.path.exists(fp):
            try:
                sz = os.path.getsize(fp)
                os.remove(fp)
                freed_bytes += sz
                deleted_files += 1
            except Exception as e:
                errors.append(f"Failed to delete annotation file {os.path.basename(fp)}: {e}")
 
    # 3. Update database global index ONLY if all files deleted successfully
    db_updated = False
    if len(errors) == 0:
        active_items = get_active_items()
        filtered_items = [item for item in active_items if item["uuid"].lower() != uuid]
        if len(active_items) != len(filtered_items):
            db_updated = save_active_items(filtered_items)
            
    if errors:
        return {
            "success": False,
            "error": "Ошибка при удалении файлов: " + "; ".join(errors),
            "db_updated": db_updated,
            "freed_bytes": freed_bytes,
            "freed_str": format_size(freed_bytes),
            "errors": errors
        }

    return {
        "success": True,
        "db_updated": db_updated,
        "freed_bytes": freed_bytes,
        "freed_str": format_size(freed_bytes),
        "errors": []
    }

def do_restore(uuid, title):
    uuid = uuid.lower()
    active_items = get_active_items()
    
    if any(item["uuid"].lower() == uuid for item in active_items):
        return {"success": True, "already_active": True}
        
    created_at = int(datetime.datetime.now().timestamp())
    brain_path = os.path.join(brain_dir, uuid)
    if os.path.exists(brain_path):
        try:
            created_at = int(os.path.getctime(brain_path))
        except Exception:
            pass
            
    inner_bytes = serialize_inner_summary(title, created_at, 0, 0)
    inner_b64 = base64.b64encode(inner_bytes).decode('utf-8')
    
    item = bytearray()
    uuid_bytes = uuid.encode('utf-8')
    item.extend(encode_varint((1 << 3) | 2))
    item.extend(encode_varint(len(uuid_bytes)))
    item.extend(uuid_bytes)
    
    sub_msg = bytearray()
    b64_bytes = inner_b64.encode('utf-8')
    sub_msg.extend(encode_varint((1 << 3) | 2))
    sub_msg.extend(encode_varint(len(b64_bytes)))
    sub_msg.extend(b64_bytes)
    
    item.extend(encode_varint((2 << 3) | 2))
    item.extend(encode_varint(len(sub_msg)))
    item.extend(sub_msg)
    
    new_item = {
        "uuid": uuid,
        "title": title,
        "created_at": created_at,
        "raw_bytes": bytes(item)
    }
    
    active_items.append(new_item)
    success = save_active_items(active_items)
    
    return {
        "success": success,
        "uuid": uuid,
        "title": title
    }

def do_restore_all_orphaned():
    active_items = get_active_items()
    active_uuids = {item["uuid"].lower() for item in active_items}
    
    brain_uuids = []
    if os.path.exists(brain_dir):
        for name in os.listdir(brain_dir):
            if os.path.isdir(os.path.join(brain_dir, name)):
                if re.match(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', name):
                    brain_uuids.append(name.lower())
                    
    conv_uuids = set()
    if os.path.exists(conversations_dir):
        for name in os.listdir(conversations_dir):
            match = re.match(r'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', name)
            if match:
                conv_uuids.add(match.group(1).lower())
                
    annot_uuids = set()
    if os.path.exists(annotations_dir):
        for name in os.listdir(annotations_dir):
            match = re.match(r'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', name)
            if match:
                annot_uuids.add(match.group(1).lower())
                
    all_disk_uuids = set(brain_uuids).union(conv_uuids).union(annot_uuids)
    orphaned_uuids = all_disk_uuids.difference(active_uuids)
    
    restored_count = 0
    errors = []
    
    if not orphaned_uuids:
        return {"success": True, "restored_count": 0, "message": "No orphaned conversations found."}
        
    for uuid in orphaned_uuids:
        try:
            title = get_heuristic_title(uuid)
            created_at = int(datetime.datetime.now().timestamp())
            brain_path = os.path.join(brain_dir, uuid)
            if os.path.exists(brain_path):
                try:
                    created_at = int(os.path.getctime(brain_path))
                except Exception:
                    pass
            
            inner_bytes = serialize_inner_summary(title, created_at, 0, 0)
            inner_b64 = base64.b64encode(inner_bytes).decode('utf-8')
            
            item = bytearray()
            uuid_bytes = uuid.encode('utf-8')
            item.extend(encode_varint((1 << 3) | 2))
            item.extend(encode_varint(len(uuid_bytes)))
            item.extend(uuid_bytes)
            
            sub_msg = bytearray()
            b64_bytes = inner_b64.encode('utf-8')
            sub_msg.extend(encode_varint((1 << 3) | 2))
            sub_msg.extend(encode_varint(len(b64_bytes)))
            sub_msg.extend(b64_bytes)
            
            item.extend(encode_varint((2 << 3) | 2))
            item.extend(encode_varint(len(sub_msg)))
            item.extend(sub_msg)
            
            new_item = {
                "uuid": uuid,
                "title": title,
                "created_at": created_at,
                "raw_bytes": bytes(item)
            }
            active_items.append(new_item)
            restored_count += 1
        except Exception as e:
            errors.append(f"Failed to prepare {uuid}: {e}")
            
    success = False
    if restored_count > 0:
        success = save_active_items(active_items)
        
    return {
        "success": success if restored_count > 0 else True,
        "restored_count": restored_count,
        "errors": errors
    }

def do_delete_all_orphaned(current_title_or_uuid=None):
    active_items = get_active_items()
    active_uuids = {item["uuid"].lower() for item in active_items}
    
    curr_uuid = None
    if current_title_or_uuid:
        if re.match(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', current_title_or_uuid):
            curr_uuid = current_title_or_uuid.lower()
        else:
            curr_title_lower = current_title_or_uuid.strip().lower()
            for item in active_items:
                if match_title(item["title"], curr_title_lower):
                    curr_uuid = item["uuid"].lower()
                    break
            if not curr_uuid:
                # Fallback to check on-disk directories (e.g. for orphaned currently active conversations)
                disk_uuids_tmp = []
                if os.path.exists(brain_dir):
                    for name in os.listdir(brain_dir):
                        if os.path.isdir(os.path.join(brain_dir, name)):
                            if re.match(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', name):
                                disk_uuids_tmp.append(name.lower())
                for u in disk_uuids_tmp:
                    t = get_heuristic_title(u)
                    if match_title(t, curr_title_lower):
                        curr_uuid = u
                        break
    
    brain_uuids = []
    if os.path.exists(brain_dir):
        for name in os.listdir(brain_dir):
            if os.path.isdir(os.path.join(brain_dir, name)):
                if re.match(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', name):
                    brain_uuids.append(name.lower())
                    
    conv_uuids = set()
    if os.path.exists(conversations_dir):
        for name in os.listdir(conversations_dir):
            match = re.match(r'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', name)
            if match:
                conv_uuids.add(match.group(1).lower())
                
    annot_uuids = set()
    if os.path.exists(annotations_dir):
        for name in os.listdir(annotations_dir):
            match = re.match(r'^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})', name)
            if match:
                annot_uuids.add(match.group(1).lower())
                
    all_disk_uuids = set(brain_uuids).union(conv_uuids).union(annot_uuids)
    orphaned_uuids = all_disk_uuids.difference(active_uuids)
    
    if curr_uuid and curr_uuid in orphaned_uuids:
        orphaned_uuids.remove(curr_uuid)
        
    deleted_count = 0
    freed_bytes = 0
    errors = []
    
    for uuid in orphaned_uuids:
        brain_path = os.path.join(brain_dir, uuid)
        conv_files = []
        if os.path.exists(conversations_dir):
            for f in os.listdir(conversations_dir):
                if f.startswith(uuid):
                    conv_files.append(os.path.join(conversations_dir, f))
                    
        annot_files = []
        if os.path.exists(annotations_dir):
            for f in os.listdir(annotations_dir):
                if f.startswith(uuid):
                    annot_files.append(os.path.join(annotations_dir, f))
                    
        is_locked = False
        if os.path.exists(brain_path):
            try:
                temp_brain = brain_path + ".lock_test"
                os.rename(brain_path, temp_brain)
                os.rename(temp_brain, brain_path)
            except Exception:
                is_locked = True
                
        for fp in conv_files:
            try:
                temp_fp = fp + ".lock_test"
                os.rename(fp, temp_fp)
                os.rename(temp_fp, fp)
            except Exception:
                is_locked = True
                
        for fp in annot_files:
            try:
                temp_fp = fp + ".lock_test"
                os.rename(fp, temp_fp)
                os.rename(temp_fp, fp)
            except Exception:
                is_locked = True
                
        if is_locked:
            errors.append(f"Conversation {uuid[:8]} has locked files and was skipped.")
            continue
            
        try:
            sz = 0
            if os.path.exists(brain_path):
                for root, dirs, files in os.walk(brain_path):
                    for f in files:
                        fp = os.path.join(root, f)
                        try: sz += os.path.getsize(fp)
                        except OSError: pass
                shutil.rmtree(brain_path)
                
            for fp in conv_files:
                if os.path.exists(fp):
                    sz += os.path.getsize(fp)
                    os.remove(fp)
                    
            for fp in annot_files:
                if os.path.exists(fp):
                    sz += os.path.getsize(fp)
                    os.remove(fp)
                    
            freed_bytes += sz
            deleted_count += 1
        except Exception as e:
            errors.append(f"Failed to delete {uuid[:8]}: {e}")
            
    return {
        "success": len(errors) == 0,
        "deleted_count": deleted_count,
        "freed_bytes": freed_bytes,
        "freed_str": format_size(freed_bytes),
        "errors": errors
    }

def get_dialogue_note(uuid):
    if not os.path.exists(annotations_dir):
        return ""
    note_path = os.path.join(annotations_dir, f"{uuid}_note.txt")
    if os.path.exists(note_path):
        try:
            with open(note_path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except:
            pass
    return ""

def do_save_note(uuid, note_text):
    try:
        if not os.path.exists(annotations_dir):
            os.makedirs(annotations_dir, exist_ok=True)
        note_path = os.path.join(annotations_dir, f"{uuid}_note.txt")
        if note_text.strip():
            with open(note_path, "w", encoding="utf-8") as f:
                f.write(note_text.strip())
        else:
            if os.path.exists(note_path):
                os.remove(note_path)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No action specified. Use 'list', 'delete', or 'restore'."}))
        sys.exit(1)
        
    action = sys.argv[1]
    
    if action == "list":
        current_title_or_uuid = sys.argv[2] if len(sys.argv) > 2 else None
        res = do_list(current_title_or_uuid)
        print(json.dumps(res, ensure_ascii=False))
    elif action == "delete":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "UUID required for delete action."}))
            sys.exit(1)
        uuid = sys.argv[2]
        current_title_or_uuid = sys.argv[3] if len(sys.argv) > 3 else None
        res = do_delete(uuid, current_title_or_uuid)
        print(json.dumps(res, ensure_ascii=False))
    elif action == "restore":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "UUID required for restore action."}))
            sys.exit(1)
        uuid = sys.argv[2]
        title = sys.argv[3] if len(sys.argv) > 3 else get_heuristic_title(uuid)
        res = do_restore(uuid, title)
        print(json.dumps(res, ensure_ascii=False))
    elif action == "restore_all_orphaned":
        res = do_restore_all_orphaned()
        print(json.dumps(res, ensure_ascii=False))
    elif action == "delete_all_orphaned":
        current_title_or_uuid = sys.argv[2] if len(sys.argv) > 2 else None
        res = do_delete_all_orphaned(current_title_or_uuid)
        print(json.dumps(res, ensure_ascii=False))
    elif action == "save_note":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "UUID required for save_note action."}))
            sys.exit(1)
        uuid = sys.argv[2]
        note_text = sys.argv[3] if len(sys.argv) > 3 else ""
        res = do_save_note(uuid, note_text)
        print(json.dumps(res, ensure_ascii=False))
    else:
        print(json.dumps({"error": f"Unknown action: {action}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
