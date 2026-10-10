const USERS_API = "https://users.roproxy.com/v1/users/";
const USERNAME_LOOKUP_API = "https://users.roproxy.com/v1/usernames/users";
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
    }[c]));
}

// Roblox often returns "Pending" on the first thumbnail call — retry until done
async function fetchAvatarThumbnail(userId, maxAttempts = 5) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
        try {
            const res = await fetch(AVATAR_THUMBNAILS_API + userId);
            if (!res.ok) continue;
            const data = await res.json();
            const thumb = data.data?.[0];
            if (thumb?.state === "Completed" && thumb.imageUrl) return thumb.imageUrl;
            if (thumb && thumb.state !== "Pending") return ""; // blocked/moderated
        } catch (_) {}
    }
    return "";
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

        const avatarImageUrl = await fetchAvatarThumbnail(userId);

        const displayName = escapeHtml(userData.displayName);
        const userName = escapeHtml(userData.name);

        profileContainer.innerHTML = `
            <div class="profile-card">
                <h2>${displayName}</h2>
                <p style="color: #aaa;">@${userName} (ID: ${userId})</p>
                ${avatarImageUrl ? `<img class="avatar-img" src="${avatarImageUrl}" alt="Avatar">` : ''}
                <br><br>
                <button onclick="fetchOutfits('${userId}')">Load Saved Outfits</button>
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

    statusText.textContent = "Fetching outfits...";
    outfitsContainer.innerHTML = "";
    loadedOutfitsRaw = [];

    try {
        let allItems = [];
        let page = 1;
        const MAX_PAGES = 25;

        while (page <= MAX_PAGES) {
            statusText.textContent = `Scanning outfits (page ${page})...`;

            const data = await fetchWithFallbacks(
                `v1/users/${userId}/outfits?page=${page}&itemsPerPage=50`
            );

            const items = Array.isArray(data) ? data : (data?.data || []);

            if (items.length === 0) break;
            allItems = allItems.concat(items);
            if (items.length < 50) break;

            page++;
            await new Promise(r => setTimeout(r, 250));
        }

        loadedOutfitsRaw = allItems;

        if (loadedOutfitsRaw.length === 0) {
            renderFallbackPanel(userId, "Roblox returned no outfits for this player (or their outfits are private).");
            return;
        }

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
            renderFallbackPanel(userId, "This player's outfits/inventory are <b>private</b>.");
        } else if (error.status === 429) {
            statusText.textContent = "Failed: Roblox rate limit reached. Please wait a few seconds and try again.";
        } else {
            statusText.textContent = `Failed: ${error.message}`;
        }
        console.error(error);
    }
}

// Shown instead of a dead-end error when the outfit list is blocked
function renderFallbackPanel(userId, reason) {
    const statusText = document.getElementById('statusText');
    const outfitsContainer = document.getElementById('outfitsContainer');

    statusText.innerHTML = `<span style="color: #ffaa00;">⚠️ ${reason}<br>Roblox blocks <i>listing</i> outfits for every endpoint and proxy — but any <b>outfit ID</b> still works fully (thumbnail, accessories, and the Use Avatar script).</span>`;

    outfitsContainer.innerHTML = `
        <div class="profile-card" style="max-width: 440px;">
            <p style="color:#ccc; margin-bottom:10px;">Have an outfit ID? Load it directly:</p>
            <div style="display:flex; gap:8px; justify-content:center; flex-wrap:wrap;">
                <input id="outfitIdInput" placeholder="Outfit ID (e.g. 123456789)"
                    style="padding:8px; border-radius:6px; border:1px solid #444; background:#1a1a1a; color:#eee; width:210px;">
                <button onclick="loadOutfitById()">Load Outfit</button>
            </div>
            <p style="color:#888; font-size:12px; margin-top:10px;">
                Outfit IDs appear in the URL on roblox.com's outfits page — IDs themselves aren't privacy-protected.
            </p>
        </div>`;
}

// Works even when the outfit list is private — same trick the in-game loaders use
async function loadOutfitById() {
    const statusText = document.getElementById('statusText');
    const outfitsContainer = document.getElementById('outfitsContainer');

    const raw = document.getElementById('outfitIdInput')?.value.trim() || "";
    const id = (raw.match(/\d{3,}/) || [])[0];
    if (!id) {
        statusText.textContent = "Enter a valid outfit ID.";
        return;
    }

    statusText.textContent = `Loading outfit ${id}...`;
    outfitsContainer.innerHTML = "";

    let name = "Outfit " + id;
    try {
        const details = await fetchWithFallbacks(`v1/outfits/${id}/details`);
        name = details.name || name;
    } catch (_) {
        // Details may be gated — thumbnail + script still work, so keep going
    }

    await renderOutfitList([{ id: Number(id), name }]);
    statusText.textContent = "";
}

async function renderOutfitList(outfits) {
    const outfitsContainer = document.getElementById('outfitsContainer');
    outfitsContainer.innerHTML = "";

    // Render all cards immediately with placeholders — UI never blocks on images
    const ids = [];
    outfits.forEach(outfit => {
        const outfitDiv = document.createElement('div');
        outfitDiv.className = 'outfit-card';

        const safeName = escapeHtml(outfit.name || "Outfit");
        const tag = outfit.isEditable === false ? `<span style="font-size: 11px; color: #888;">[Bundle/Head]</span><br>` : '';

        outfitDiv.innerHTML = `
            <h3 title="${safeName}">${safeName}</h3>
            ${tag}
            <div class="outfit-thumb-slot" id="thumb-${outfit.id}">
                <p style="color:#666; font-size:12px;">Loading image...</p>
            </div>
            <div class="action-buttons">
                <button onclick="fetchAccessories('${outfit.id}', this)">Accessories</button>
                <button class="copy-btn" onclick="copyAvatarScript('${outfit.id}', this)">Use Avatar</button>
            </div>
            <div id="acc-${outfit.id}" class="accessories-list"></div>
        `;
        outfitsContainer.appendChild(outfitDiv);
        ids.push(Number(outfit.id));
    });

    // Fill in thumbnails in parallel, with retries for "Pending" ones
    const chunkSize = 50;
    const jobs = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
        jobs.push(fillOutfitThumbnails(ids.slice(i, i + chunkSize)));
    }
    await Promise.all(jobs);
}

async function fillOutfitThumbnails(ids) {
    const pending = new Set(ids);
    const MAX_ATTEMPTS = 6;

    for (let attempt = 0; attempt < MAX_ATTEMPTS && pending.size > 0; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 1500));

        let batch = null;
        try {
            const res = await fetch(OUTFIT_THUMBNAILS_API + [...pending].join(','));
            if (res.ok) batch = await res.json();
        } catch (_) {}
        if (!batch || !batch.data) continue;

        for (const thumb of batch.data) {
            const tid = Number(thumb.targetId);
            if (!pending.has(tid)) continue;

            const slot = document.getElementById(`thumb-${tid}`);
            if (thumb.state === "Completed" && thumb.imageUrl) {
                if (slot) slot.innerHTML = `<img class="outfit-thumbnail" src="${thumb.imageUrl}" alt="Outfit Image">`;
                pending.delete(tid);
            } else if (thumb.state !== "Pending") {
                // Blocked / moderated / error state — stop retrying this one
                if (slot) slot.innerHTML = `<p style="color:#666; font-size:12px;">No image</p>`;
                pending.delete(tid);
            }
            // state "Pending" → keep it in the set and retry next attempt
        }
    }

    // Anything still unresolved after all retries
    pending.forEach(tid => {
        const slot = document.getElementById(`thumb-${tid}`);
        if (slot) slot.innerHTML = `<p style="color:#666; font-size:12px;">No image</p>`;
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
                const assetName = escapeHtml(asset.name);
                assetsHtml += `<li><strong>${assetName}</strong> <br><span style="color:#888; font-size:12px;">ID: ${asset.id}</span></li>`;
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
