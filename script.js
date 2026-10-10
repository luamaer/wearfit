const USERS_API = "https://users.roproxy.com/v1/users/";
const USERNAME_LOOKUP_API = "https://users.roproxy.com/v1/usernames/users";
const INVENTORY_CHECK_API = "https://inventory.roproxy.com/v1/users/";
const AVATAR_THUMBNAILS_API = "https://thumbnails.roproxy.com/v1/users/avatar?size=420x420&format=Png&isCircular=false&userIds=";
const OUTFIT_THUMBNAILS_API = "https://thumbnails.roproxy.com/v1/users/outfits?size=150x150&format=Png&isCircular=false&userOutfitIds=";

const PROXY_LIST = [
    (path) => `https://avatar.roproxy.com/${path}`,
    (path) => `https://avatar.ff-roproxy.com/${path}`,
    (path) => `https://corsproxy.io/?url=${encodeURIComponent('https://avatar.roblox.com/' + path)}`
];

async function fetchWithFallbacks(path) {
    let lastStatus = null;
    let lastError = null;

    for (const getUrl of PROXY_LIST) {
        try {
            const res = await fetch(getUrl(path));
            if (res.status === 403) {
                const err = new Error("Private inventory");
                err.status = 403;
                throw err;
            }
            if (res.status === 429) {
                lastStatus = 429;
                continue;
            }
            if (!res.ok) {
                lastStatus = res.status;
                continue;
            }

            return await res.json();
        } catch (err) {
            if (err.status === 403) throw err;
            lastError = err;
        }
    }

    if (lastStatus === 429) {
        const err = new Error("Rate limit reached. Please wait a moment.");
        err.status = 429;
        throw err;
    }
    throw lastError || new Error("Failed to reach Roblox API.");
}

function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
}

async function searchPlayer() {
    const input = document.getElementById('userIdInput').value.trim();
    const statusText = document.getElementById('statusText');
    const profileContainer = document.getElementById('profileContainer');
    const outfitsContainer = document.getElementById('outfitsContainer');

    if (!input) return;

    statusText.textContent = "Fetching player data...";
    profileContainer.innerHTML = "";
    outfitsContainer.innerHTML = "";

    try {
        let userId = input;

        if (!/^\d+$/.test(input)) {
            statusText.textContent = "Resolving username to User ID...";
            const lookupRes = await fetch(USERNAME_LOOKUP_API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ usernames: [input], excludeBannedUsers: false })
            });
            if (!lookupRes.ok) throw new Error("Could not search for username.");
            const lookupData = await lookupRes.json();
            if (!lookupData.data || lookupData.data.length === 0) {
                throw new Error(`Username "${input}" not found.`);
            }
            userId = lookupData.data[0].id;
        }

        const userRes = await fetch(USERS_API + userId);
        if (!userRes.ok) throw new Error("Player not found.");
        const userData = await userRes.json();

        let avatarImageUrl = "";
        try {
            const thumbRes = await fetch(AVATAR_THUMBNAILS_API + userId);
            const thumbData = await thumbRes.json();
            avatarImageUrl = thumbData.data?.[0]?.imageUrl || "";
        } catch (_) {}

        const safeDisplayName = escapeHtml(userData.displayName);
        const safeName = escapeHtml(userData.name);

        profileContainer.innerHTML = `
            <div class="profile-card">
                <h2>${safeDisplayName}</h2>
                <p style="color: #aaa;">@${safeName} (ID: ${userId})</p>
                ${avatarImageUrl ? `<img class="avatar-img" src="${avatarImageUrl}" alt="Avatar">` : ''}
                <br><br>
                <button onclick="fetchOutfits('${userId}')">Load Saved Outfits</button>
                <button onclick="copyUserAvatarScript('${userId}', this)">Copy Current Avatar</button>
            </div>
        `;
        statusText.textContent = "";

    } catch (error) {
        statusText.textContent = "Error: " + error.message;
    }
}

// Stores raw outfits in memory for tab filtering
let loadedOutfitsRaw = [];

async function fetchOutfits(userId) {
    const statusText = document.getElementById('statusText');
    const outfitsContainer = document.getElementById('outfitsContainer');

    statusText.textContent = "Checking inventory & fetching outfits...";
    outfitsContainer.innerHTML = "";
    loadedOutfitsRaw = [];

    try {
        // 1. Check if inventory is private
        try {
            const privCheck = await fetch(`${INVENTORY_CHECK_API}${userId}/can-view-inventory`);
            if (privCheck.ok) {
                const privData = await privCheck.json();
                if (privData.canView === false) {
                    renderPrivateFallback(userId);
                    return;
                }
            }
        } catch (_) {}

        let allItems = [];
        let page = 1;
        let isFetching = true;

        while (isFetching) {
            statusText.textContent = `Scanning outfits (page ${page})...`;

            let data = null;
            try {
                data = await fetchWithFallbacks(`v1/users/${userId}/outfits?page=${page}&itemsPerPage=50`);
            } catch (err) {
                if (err.status === 403) throw err;
            }

            if ((!data || !data.data || data.data.length === 0) && page === 1) {
                try {
                    data = await fetchWithFallbacks(`v2/avatar/users/${userId}/outfits?page=1&itemsPerPage=50`);
                } catch (_) {}
            }

            const items = Array.isArray(data) ? data : (data?.data || []);

            if (items.length > 0) {
                allItems = allItems.concat(items);
                if (items.length < 50) {
                    isFetching = false;
                } else {
                    page++;
                    await new Promise(r => setTimeout(r, 250));
                }
            } else {
                isFetching = false;
            }
        }

        loadedOutfitsRaw = allItems;

        if (loadedOutfitsRaw.length === 0) {
            renderPrivateFallback(userId, "No saved outfits were returned (inventory may be private, or the player has none). These still work:");
            return;
        }

        // Separate custom outfits from default dynamic heads / bundles
        const customOutfits = loadedOutfitsRaw.filter(item =>
            item.isEditable === true && item.outfitType !== "DynamicHead"
        );
        const starterBundles = loadedOutfitsRaw.filter(item =>
            item.isEditable === false || item.outfitType === "DynamicHead"
        );

        if (customOutfits.length > 0) {
            statusText.textContent = `Found ${customOutfits.length} custom outfits (${starterBundles.length} default heads/bundles hidden).`;
            await renderOutfitList(customOutfits);
        } else {
            statusText.innerHTML = `
                <div style="color: #ccc; margin-bottom: 12px;">
                    This player has <b>0 custom saved outfits</b>.<br>
                    <span style="font-size: 13px; color: #888;">(Roblox returned ${starterBundles.length} default starter packages/dynamic heads).</span>
                </div>
                <button onclick="renderOutfitList(loadedOutfitsRaw)">Show All ${starterBundles.length} Default Bundles/Heads</button>
            `;
        }

    } catch (error) {
        if (error.status === 403) {
            renderPrivateFallback(userId);
        } else if (error.status === 429) {
            statusText.textContent = "Failed: Roblox rate limit reached. Please wait a few seconds and try again.";
        } else {
            statusText.textContent = `Failed: ${error.message}`;
        }
        console.error(error);
    }
}

// Shown instead of a dead-end error when the outfit list is blocked:
// current-avatar copy + manual outfit ID loading always work.
function renderPrivateFallback(userId, customMessage) {
    const statusText = document.getElementById('statusText');
    const outfitsContainer = document.getElementById('outfitsContainer');

    const msg = customMessage ||
        `This player's saved outfits are <b>private</b>.<br>Roblox blocks listing them — but these still work:`;

    statusText.innerHTML = `<span style="color: #ffaa00;">⚠️ ${msg}</span>`;

    outfitsContainer.innerHTML = `
        <div class="profile-card" style="max-width: 440px;">
            <button onclick="copyUserAvatarScript('${userId}', this)">Copy Current Avatar Script</button>
            <div style="margin-top: 14px;">
                <p style="color:#bbb; font-size:13px; margin-bottom:6px;">
                    Have an outfit ID? It loads even when the list is private:
                </p>
                <input id="outfitIdInput" placeholder="Paste outfit ID (e.g. 123456789)"
                    style="padding:6px 8px; border-radius:6px; border:1px solid #444; background:#1a1a1a; color:#eee;"
                    onkeydown="if(event.key==='Enter') loadOutfitById()">
                <button onclick="loadOutfitById()">Load Outfit</button>
            </div>
        </div>`;
}

// Loads a single outfit directly by ID — bypasses the private outfit list entirely.
async function loadOutfitById() {
    const statusText = document.getElementById('statusText');
    const outfitsContainer = document.getElementById('outfitsContainer');

    const raw = document.getElementById('outfitIdInput')?.value.trim() || "";
    const id = (raw.match(/\d{3,}/) || [])[0];
    if (!id) {
        statusText.textContent = "Enter a valid outfit ID (numbers only).";
        return;
    }

    statusText.textContent = `Loading outfit ${id}...`;
    outfitsContainer.innerHTML = "";

    let name = "Outfit " + id;
    try {
        const details = await fetchWithFallbacks(`v1/outfits/${id}/details`);
        if (details && details.name) name = details.name;
    } catch (_) {
        // Details may be gated for private inventories —
        // the thumbnail and the script still work fine, so keep going.
    }

    await renderOutfitList([{ id: Number(id), name }]);
    statusText.textContent = "Loaded outfit by ID.";
}

async function renderOutfitList(outfits) {
    const statusText = document.getElementById('statusText');
    const outfitsContainer = document.getElementById('outfitsContainer');
    outfitsContainer.innerHTML = "";

    const thumbnailMap = {};
    const chunkSize = 50;

    // Batch fetch thumbnails
    for (let i = 0; i < outfits.length; i += chunkSize) {
        const chunk = outfits.slice(i, i + chunkSize);
        const outfitIds = chunk.map(outfit => outfit.id).join(',');

        try {
            const thumbnailsRes = await fetch(OUTFIT_THUMBNAILS_API + outfitIds);
            if (thumbnailsRes.ok) {
                const thumbnailsData = await thumbnailsRes.json();
                if (thumbnailsData.data) {
                    thumbnailsData.data.forEach(thumb => {
                        if (thumb.state === "Completed") {
                            thumbnailMap[thumb.targetId] = thumb.imageUrl;
                        }
                    });
                }
            }
        } catch (err) {
            console.warn("Failed loading batch images:", err);
        }
    }

    // Render cards
    outfits.forEach(outfit => {
        const imageUrl = thumbnailMap[outfit.id];
        const outfitDiv = document.createElement('div');
        outfitDiv.className = 'outfit-card';

        let imageHtml = `<p style="color:#666; font-size:12px;">Image Pending</p>`;
        if (imageUrl) {
            imageHtml = `<img class="outfit-thumbnail" src="${imageUrl}" alt="Outfit Image">`;
        }

        const safeName = escapeHtml(outfit.name || "Outfit");
        const tag = outfit.isEditable === false ? `<span style="font-size: 11px; color: #888;">[Bundle/Head]</span><br>` : '';

        outfitDiv.innerHTML = `
            <h3 title="${safeName}">${safeName}</h3>
            ${tag}
            ${imageHtml}

            <div class="action-buttons">
                <button onclick="fetchAccessories('${outfit.id}', this)">Accessories</button>
                <button class="copy-btn" onclick="copyAvatarScript('${outfit.id}', this)">Use Avatar</button>
            </div>

            <div id="acc-${outfit.id}" class="accessories-list"></div>
        `;
        outfitsContainer.appendChild(outfitDiv);
    });
}

async function fetchAccessories(outfitId, buttonElement) {
    const accContainer = document.getElementById(`acc-${outfitId}`);

    if (accContainer.innerHTML !== "") {
        const isHidden = accContainer.style.display === "none";
        accContainer.style.display = isHidden ? "block" : "none";
        return;
    }

    const originalText = buttonElement.textContent;
    buttonElement.textContent = "...";

    try {
        const detailsData = await fetchWithFallbacks(`v1/outfits/${outfitId}/details`);

        let assetsHtml = "<ul>";
        if (detailsData.assets && detailsData.assets.length > 0) {
            detailsData.assets.forEach(asset => {
                assetsHtml += `<li><strong>${escapeHtml(asset.name)}</strong> <br><span style="color:#888; font-size:12px;">ID: ${asset.id}</span></li>`;
            });
        } else {
            assetsHtml += "<li>No accessories found.</li>";
        }
        assetsHtml += "</ul>";

        accContainer.innerHTML = assetsHtml;
        accContainer.style.display = "block";
        buttonElement.textContent = originalText;

    } catch (error) {
        console.error(error);
        buttonElement.textContent = "Error";
    }
}

// ============================================================
// Script generation — one core, two modes:
//   "outfit" -> GetHumanoidDescriptionFromOutfitId (outfit cards)
//   "user"   -> GetHumanoidDescriptionFromUserId   (current avatar)
// Both calls ignore inventory privacy, which is how games like
// Avatar Catalog Creator can wear anyone's look.
// ============================================================

function copyToClipboard(text, buttonElement) {
    const originalText = buttonElement.textContent;
    const originalBg = buttonElement.style.backgroundColor;

    navigator.clipboard.writeText(text).then(() => {
        buttonElement.textContent = "Copied!";
        buttonElement.style.backgroundColor = "#10b981";
        setTimeout(() => {
            buttonElement.textContent = originalText;
            buttonElement.style.backgroundColor = originalBg;
        }, 2000);
    }).catch(err => {
        alert("Clipboard copy failed.");
        console.error("Clipboard Error:", err);
    });
}

function copyAvatarScript(outfitId, buttonElement) {
    copyAvatarScriptCore(outfitId, "outfit", buttonElement);
}

function copyUserAvatarScript(userId, buttonElement) {
    copyAvatarScriptCore(userId, "user", buttonElement);
}

function copyAvatarScriptCore(targetId, mode, buttonElement) {
    const isUser = mode === "user";
    const idVar = isUser ? "targetUserId" : "targetOutfitId";
    const descApi = isUser ? "GetHumanoidDescriptionFromUserId" : "GetHumanoidDescriptionFromOutfitId";

    const luaCode = `-- Local Avatar Changer Script (${isUser ? "Current Avatar" : "Outfit"})
local ${idVar} = ${targetId}

local Players = game:GetService("Players")
local localPlayer = Players.LocalPlayer

if _G.__AppearanceConnection then
    _G.__AppearanceConnection:Disconnect()
end

local ATTACHMENTS_INFO = {
    HatAttachment = {ParentName = "Head", CFrame = CFrame.new(0, 0.5, 0)},
    HairAttachment = {ParentName = "Head", CFrame = CFrame.new(0, 0.5, 0)},
    FaceFrontAttachment = {ParentName = "Head", CFrame = CFrame.new(0, 0.3, 0.1)},
    FaceCenterAttachment = {ParentName = "Head", CFrame = CFrame.new(0, 0.3, 0)},
    BackAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 0, -0.5)},
    FrontAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 0, 0.5)},
    WaistAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, -0.5, 0)},
    WaistFrontAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, -0.5, 0.1)},
    WaistBackAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, -0.5, -0.1)},
    WaistCenterAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, -0.5, 0)},
    NeckAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 1, 0)},
    BodyBackAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 0, -0.5)},
    BodyFrontAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 0, 0.5)},
    LeftCollarAttachment = {ParentName = "Torso", CFrame = CFrame.new(-1, 0.5, 0)},
    RightCollarAttachment = {ParentName = "Torso", CFrame = CFrame.new(1, 0.5, 0)},
    LeftShoulderAttachment = {ParentName = "Left Arm", CFrame = CFrame.new(0.5, 0.5, 0)},
    RightGripAttachment = {ParentName = "Right Arm", CFrame = CFrame.new(0, -1, 0)},
}

-- R6 part name -> R15 equivalents
local R15_PART_ALIASES = {
    ["Torso"] = {"UpperTorso", "LowerTorso"},
    ["Right Arm"] = {"RightUpperArm", "RightHand"},
    ["Left Arm"] = {"LeftUpperArm", "LeftHand"},
    ["Right Leg"] = {"RightUpperLeg", "RightFoot"},
    ["Left Leg"] = {"LeftUpperLeg", "LeftFoot"},
}

local function getBodyPart(character, partName)
    local part = character:FindFirstChild(partName)
    if not part then
        for _, alias in ipairs(R15_PART_ALIASES[partName] or {}) do
            part = character:FindFirstChild(alias)
            if part then break end
        end
    end
    return part
end

local function ensureAttachment(character, name)
    local info = ATTACHMENTS_INFO[name]
    local part
    local infoCFrame = nil

    if info then
        part = getBodyPart(character, info.ParentName)
        infoCFrame = info.CFrame
    else
        -- Unmapped attachment: look for an existing one on the rig
        for _, desc in ipairs(character:GetDescendants()) do
            if desc:IsA("Attachment") and desc.Name == name then
                return desc
            end
        end
        part = getBodyPart(character, "Torso") or character:FindFirstChild("Head")
    end

    if not part then return nil end

    local att = part:FindFirstChild(name)
    if not att then
        att = Instance.new("Attachment")
        att.Name = name
        att.CFrame = infoCFrame or CFrame.new()
        att.Parent = part
    end
    return att
end

local function attachAccessory(character, accessory)
    local handle = accessory:FindFirstChild("Handle")
    if not handle then return end

    handle.CanCollide = false
    handle.Massless = true

    for _, child in ipairs(handle:GetChildren()) do
        if child:IsA("Weld") or child:IsA("Motor6D") or child:IsA("WeldConstraint") then
            child:Destroy()
        end
    end

    local handleAttachments = {}
    for _, att in ipairs(handle:GetChildren()) do
        if att:IsA("Attachment") then
            table.insert(handleAttachments, att)
        end
    end

    local attached = false
    for _, handleAtt in ipairs(handleAttachments) do
        local charAtt = ensureAttachment(character, handleAtt.Name)
        if charAtt then
            local joint = Instance.new("Motor6D")
            joint.Name = "AccessoryMotor6D"
            joint.Part0 = charAtt.Parent
            joint.Part1 = handle
            joint.C0 = charAtt.CFrame
            joint.C1 = handleAtt.CFrame
            joint.Parent = handle
            attached = true
        end
    end

    -- Fallback: weld to Head if nothing matched
    if not attached then
        local head = character:FindFirstChild("Head")
        if head then
            local joint = Instance.new("Motor6D")
            joint.Name = "AccessoryMotor6D"
            joint.Part0 = head
            joint.Part1 = handle
            joint.C0 = CFrame.new(0, 0.5, 0)
            joint.C1 = CFrame.new()
            joint.Parent = handle
        end
    end

    accessory.Parent = character
end

local function clearAppearance(character)
    for _, obj in ipairs(character:GetChildren()) do
        if obj:IsA("Accessory") or obj:IsA("Hat") or
           obj:IsA("Shirt") or obj:IsA("Pants") or obj:IsA("ShirtGraphic") or
           obj:IsA("CharacterMesh") or obj:IsA("BodyColors") then
            obj:Destroy()
        end
    end

    local head = character:FindFirstChild("Head")
    if head then
        for _, obj in ipairs(head:GetChildren()) do
            if obj:IsA("Decal") or obj:IsA("SpecialMesh") or obj:IsA("MeshPart") then
                obj:Destroy()
            end
        end
        head.Transparency = 0
        head.CanCollide = true
    end
end

local function fixHead(character, description, appearanceModel)
    local head = character:FindFirstChild("Head")
    if not head then return end

    head.Transparency = 0
    head.CanCollide = true

    for _, child in ipairs(head:GetChildren()) do
        if child:IsA("SpecialMesh") or child:IsA("MeshPart") or child:IsA("Decal") then
            child:Destroy()
        end
    end

    local appliedMesh = false
    local appliedFace = false

    -- Head mesh straight from the description
    if description.Head ~= 0 then
        local mesh = Instance.new("SpecialMesh")
        mesh.MeshType = Enum.MeshType.FileMesh
        mesh.MeshId = "rbxassetid://" .. description.Head
        mesh.Scale = Vector3.new(description.HeadScale, description.HeadScale, description.HeadScale)
        mesh.Parent = head
        appliedMesh = true
    end

    if description.Face ~= 0 then
        local face = Instance.new("Decal")
        face.Name = "face"
        face.Texture = "rbxassetid://" .. description.Face
        face.Parent = head
        appliedFace = true
    end

    -- Fallbacks from the assembled appearance model
    if not appliedMesh then
        for _, item in ipairs(appearanceModel:GetDescendants()) do
            if item:IsA("CharacterMesh") and item.BodyPart == Enum.BodyPart.Head then
                local mesh = Instance.new("SpecialMesh")
                mesh.MeshType = Enum.MeshType.FileMesh
                mesh.MeshId = "rbxassetid://" .. item.MeshId
                mesh.TextureId = "rbxassetid://" .. item.BaseTextureId
                mesh.Scale = Vector3.new(1.25, 1.25, 1.25)
                mesh.Parent = head
                appliedMesh = true
                break
            elseif item:IsA("MeshPart") and item.Name == "Head" then
                local mesh = Instance.new("SpecialMesh")
                mesh.MeshType = Enum.MeshType.FileMesh
                mesh.MeshId = item.MeshId
                mesh.TextureId = item.TextureID
                mesh.Scale = item.Size
                mesh.Parent = head
                appliedMesh = true
                break
            end
        end
    end

    if not appliedFace then
        for _, item in ipairs(appearanceModel:GetDescendants()) do
            if item:IsA("Decal") and item.Name == "face" then
                item:Clone().Parent = head
                appliedFace = true
                break
            end
        end
    end

    if not appliedMesh then
        local mesh = Instance.new("SpecialMesh")
        mesh.MeshType = Enum.MeshType.Head
        mesh.Scale = Vector3.new(1.25, 1.25, 1.25)
        mesh.Parent = head
    end

    if not appliedFace then
        local defaultFace = Instance.new("Decal")
        defaultFace.Name = "face"
        defaultFace.Texture = "rbxasset://textures/face.png"
        defaultFace.Parent = head
    end
end

local function applyOutfit(descId)
    local character = localPlayer.Character or localPlayer.CharacterAdded:Wait()
    local humanoid = character:WaitForChild("Humanoid")

    local success, description = pcall(function()
        return Players:${descApi}(descId)
    end)
    if not success or not description then
        warn("Failed to fetch HumanoidDescription for", "${isUser ? "user" : "outfit"}", descId)
        return
    end

    -- Assemble the full outfit as a real model in the local rig type
    local successModel, appearanceModel = pcall(function()
        return Players:CreateHumanoidModelFromDescription(description, humanoid.RigType)
    end)
    if not successModel or not appearanceModel then
        warn("Failed to build appearance model for", descId)
        return
    end

    clearAppearance(character)

    -- Clothing, body colors, meshes
    for _, obj in ipairs(appearanceModel:GetDescendants()) do
        if obj:IsA("Shirt") or obj:IsA("Pants") or obj:IsA("ShirtGraphic") or
           obj:IsA("BodyColors") or obj:IsA("CharacterMesh") then
            obj:Clone().Parent = character
        end
    end

    -- Accessories
    for _, acc in ipairs(appearanceModel:GetChildren()) do
        if acc:IsA("Accessory") or acc:IsA("Hat") then
            attachAccessory(character, acc:Clone())
        end
    end

    fixHead(character, description, appearanceModel)

    appearanceModel:Destroy()
end

local function onCharacter(character)
    character:WaitForChild("Humanoid")
    character:WaitForChild("HumanoidRootPart")
    task.wait(0.1)
    applyOutfit(${idVar})
end

_G.__AppearanceConnection = localPlayer.CharacterAppearanceLoaded:Connect(onCharacter)

if localPlayer.Character then
    task.spawn(onCharacter, localPlayer.Character)
end`;

    copyToClipboard(luaCode, buttonElement);
}
// Generates the Lua script and copies it to the user's clipboard
function copyAvatarScript(outfitId, buttonElement) {
    const luaCode = `-- Local Avatar Changer Script (Outfit Edition)
local targetOutfitId = ${outfitId}

local Players = game:GetService("Players")
local localPlayer = Players.LocalPlayer

if _G.__AppearanceConnection then
    _G.__AppearanceConnection:Disconnect()
end

local ATTACHMENTS_INFO = {
    HatAttachment = {ParentName = "Head", CFrame = CFrame.new(0, 0.5, 0)},
    HairAttachment = {ParentName = "Head", CFrame = CFrame.new(0, 0.5, 0)},
    FaceFrontAttachment = {ParentName = "Head", CFrame = CFrame.new(0, 0.3, 0.1)},
    FaceCenterAttachment = {ParentName = "Head", CFrame = CFrame.new(0, 0.3, 0)},
    BackAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 0, -0.5)},
    FrontAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 0, 0.5)},
    WaistAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, -0.5, 0)},
    WaistFrontAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, -0.5, 0.1)},
    WaistBackAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, -0.5, -0.1)},
    WaistCenterAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, -0.5, 0)},
    NeckAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 1, 0)},
    BodyBackAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 0, -0.5)},
    BodyFrontAttachment = {ParentName = "Torso", CFrame = CFrame.new(0, 0, 0.5)},
    LeftCollarAttachment = {ParentName = "Torso", CFrame = CFrame.new(-1, 0.5, 0)},
    RightCollarAttachment = {ParentName = "Torso", CFrame = CFrame.new(1, 0.5, 0)},
    LeftShoulderAttachment = {ParentName = "Left Arm", CFrame = CFrame.new(0.5, 0.5, 0)},
    RightGripAttachment = {ParentName = "Right Arm", CFrame = CFrame.new(0, -1, 0)},
}

-- R6 part name -> R15 equivalents
local R15_PART_ALIASES = {
    ["Torso"] = {"UpperTorso", "LowerTorso"},
    ["Right Arm"] = {"RightUpperArm", "RightHand"},
    ["Left Arm"] = {"LeftUpperArm", "LeftHand"},
    ["Right Leg"] = {"RightUpperLeg", "RightFoot"},
    ["Left Leg"] = {"LeftUpperLeg", "LeftFoot"},
}

local function getBodyPart(character, partName)
    local part = character:FindFirstChild(partName)
    if not part then
        for _, alias in ipairs(R15_PART_ALIASES[partName] or {}) do
            part = character:FindFirstChild(alias)
            if part then break end
        end
    end
    return part
end

local function ensureAttachment(character, name)
    local info = ATTACHMENTS_INFO[name]
    local part
    local infoCFrame = nil

    if info then
        part = getBodyPart(character, info.ParentName)
        infoCFrame = info.CFrame
    else
        -- Unmapped attachment: look for an existing one on the rig
        for _, desc in ipairs(character:GetDescendants()) do
            if desc:IsA("Attachment") and desc.Name == name then
                return desc
            end
        end
        part = getBodyPart(character, "Torso") or character:FindFirstChild("Head")
    end

    if not part then return nil end

    local att = part:FindFirstChild(name)
    if not att then
        att = Instance.new("Attachment")
        att.Name = name
        att.CFrame = infoCFrame or CFrame.new()
        att.Parent = part
    end
    return att
end

local function attachAccessory(character, accessory)
    local handle = accessory:FindFirstChild("Handle")
    if not handle then return end

    handle.CanCollide = false
    handle.Massless = true

    for _, child in ipairs(handle:GetChildren()) do
        if child:IsA("Weld") or child:IsA("Motor6D") or child:IsA("WeldConstraint") then
            child:Destroy()
        end
    end

    local handleAttachments = {}
    for _, att in ipairs(handle:GetChildren()) do
        if att:IsA("Attachment") then
            table.insert(handleAttachments, att)
        end
    end

    local attached = false
    for _, handleAtt in ipairs(handleAttachments) do
        local charAtt = ensureAttachment(character, handleAtt.Name)
        if charAtt then
            local joint = Instance.new("Motor6D")
            joint.Name = "AccessoryMotor6D"
            joint.Part0 = charAtt.Parent
            joint.Part1 = handle
            joint.C0 = charAtt.CFrame
            joint.C1 = handleAtt.CFrame
            joint.Parent = handle
            attached = true
        end
    end

    -- Fallback: weld to Head if nothing matched
    if not attached then
        local head = character:FindFirstChild("Head")
        if head then
            local joint = Instance.new("Motor6D")
            joint.Name = "AccessoryMotor6D"
            joint.Part0 = head
            joint.Part1 = handle
            joint.C0 = CFrame.new(0, 0.5, 0)
            joint.C1 = CFrame.new()
            joint.Parent = handle
        end
    end

    accessory.Parent = character
end

local function clearAppearance(character)
    for _, obj in ipairs(character:GetChildren()) do
        if obj:IsA("Accessory") or obj:IsA("Hat") or
           obj:IsA("Shirt") or obj:IsA("Pants") or obj:IsA("ShirtGraphic") or
           obj:IsA("CharacterMesh") or obj:IsA("BodyColors") then
            obj:Destroy()
        end
    end

    local head = character:FindFirstChild("Head")
    if head then
        for _, obj in ipairs(head:GetChildren()) do
            if obj:IsA("Decal") or obj:IsA("SpecialMesh") or obj:IsA("MeshPart") then
                obj:Destroy()
            end
        end
        head.Transparency = 0
        head.CanCollide = true
    end
end

local function fixHead(character, description, appearanceModel)
    local head = character:FindFirstChild("Head")
    if not head then return end

    head.Transparency = 0
    head.CanCollide = true

    for _, child in ipairs(head:GetChildren()) do
        if child:IsA("SpecialMesh") or child:IsA("MeshPart") or child:IsA("Decal") then
            child:Destroy()
        end
    end

    local appliedMesh = false
    local appliedFace = false

    -- Head mesh straight from the outfit's HumanoidDescription
    if description.Head ~= 0 then
        local mesh = Instance.new("SpecialMesh")
        mesh.MeshType = Enum.MeshType.FileMesh
        mesh.MeshId = "rbxassetid://" .. description.Head
        mesh.Scale = Vector3.new(description.HeadScale, description.HeadScale, description.HeadScale)
        mesh.Parent = head
        appliedMesh = true
    end

    if description.Face ~= 0 then
        local face = Instance.new("Decal")
        face.Name = "face"
        face.Texture = "rbxassetid://" .. description.Face
        face.Parent = head
        appliedFace = true
    end

    -- Fallbacks from the assembled appearance model
    if not appliedMesh then
        for _, item in ipairs(appearanceModel:GetDescendants()) do
            if item:IsA("CharacterMesh") and item.BodyPart == Enum.BodyPart.Head then
                local mesh = Instance.new("SpecialMesh")
                mesh.MeshType = Enum.MeshType.FileMesh
                mesh.MeshId = "rbxassetid://" .. item.MeshId
                mesh.TextureId = "rbxassetid://" .. item.BaseTextureId
                mesh.Scale = Vector3.new(1.25, 1.25, 1.25)
                mesh.Parent = head
                appliedMesh = true
                break
            elseif item:IsA("MeshPart") and item.Name == "Head" then
                local mesh = Instance.new("SpecialMesh")
                mesh.MeshType = Enum.MeshType.FileMesh
                mesh.MeshId = item.MeshId
                mesh.TextureId = item.TextureID
                mesh.Scale = item.Size
                mesh.Parent = head
                appliedMesh = true
                break
            end
        end
    end

    if not appliedFace then
        for _, item in ipairs(appearanceModel:GetDescendants()) do
            if item:IsA("Decal") and item.Name == "face" then
                item:Clone().Parent = head
                appliedFace = true
                break
            end
        end
    end

    if not appliedMesh then
        local mesh = Instance.new("SpecialMesh")
        mesh.MeshType = Enum.MeshType.Head
        mesh.Scale = Vector3.new(1.25, 1.25, 1.25)
        mesh.Parent = head
    end

    if not appliedFace then
        local defaultFace = Instance.new("Decal")
        defaultFace.Name = "face"
        defaultFace.Texture = "rbxasset://textures/face.png"
        defaultFace.Parent = head
    end
end

local function applyOutfit(outfitId)
    local character = localPlayer.Character or localPlayer.CharacterAdded:Wait()
    local humanoid = character:WaitForChild("Humanoid")

    local success, description = pcall(function()
        return Players:GetHumanoidDescriptionFromOutfitId(outfitId)
    end)
    if not success or not description then
        warn("Failed to fetch HumanoidDescription for outfit:", outfitId)
        return
    end

    -- Assemble the full outfit as a real model in the local rig type
    local successModel, appearanceModel = pcall(function()
        return Players:CreateHumanoidModelFromDescription(description, humanoid.RigType)
    end)
    if not successModel or not appearanceModel then
        warn("Failed to build appearance model for outfit:", outfitId)
        return
    end

    clearAppearance(character)

    -- Clothing, body colors, meshes
    for _, obj in ipairs(appearanceModel:GetDescendants()) do
        if obj:IsA("Shirt") or obj:IsA("Pants") or obj:IsA("ShirtGraphic") or
           obj:IsA("BodyColors") or obj:IsA("CharacterMesh") then
            obj:Clone().Parent = character
        end
    end

    -- Accessories
    for _, acc in ipairs(appearanceModel:GetChildren()) do
        if acc:IsA("Accessory") or acc:IsA("Hat") then
            attachAccessory(character, acc:Clone())
        end
    end

    fixHead(character, description, appearanceModel)

    appearanceModel:Destroy()
end

local function onCharacter(character)
    character:WaitForChild("Humanoid")
    character:WaitForChild("HumanoidRootPart")
    task.wait(0.1)
    applyOutfit(targetOutfitId)
end

_G.__AppearanceConnection = localPlayer.CharacterAppearanceLoaded:Connect(onCharacter)

if localPlayer.Character then
    task.spawn(onCharacter, localPlayer.Character)
end`;

    navigator.clipboard.writeText(luaCode).then(() => {
        const originalText = buttonElement.textContent;
        const originalBg = buttonElement.style.backgroundColor;
        
        buttonElement.textContent = "Copied!";
        buttonElement.style.backgroundColor = "#10b981"; 
        
        setTimeout(() => {
            buttonElement.textContent = originalText;
            buttonElement.style.backgroundColor = originalBg;
        }, 2000);
    }).catch(err => {
        alert("Clipboard copy failed.");
        console.error("Clipboard Error:", err);
    });
}
