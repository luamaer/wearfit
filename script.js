const PROXY = "https://rbx-proxy.YOUR-SUB.workers.dev";

const USERS_API = `${PROXY}/users/v1/users/`;
const AVATAR_THUMBNAILS_API = `${PROXY}/thumbnails/v1/users/avatar?size=420x420&format=Png&isCircular=false&userIds=`;
const AVATAR_API = `${PROXY}/avatar/v1/`;
const OUTFIT_THUMBNAILS_API = `${PROXY}/thumbnails/v1/users/outfits?size=150x150&format=Png&isCircular=false&userOutfitIds=`;
// --- rate-limit armor: global spacing + retry with backoff ---
let __rlChain = Promise.resolve();
function rlGate(ms = 250) {
    const slot = __rlChain.then(() => new Promise(r => setTimeout(r, ms)));
    __rlChain = slot;
    return slot;
}

async function robloxFetch(url, retries = 5) {
    let lastErr = new Error("fetch failed");
    for (let attempt = 1; attempt <= retries; attempt++) {
        await rlGate();
        let res;
        try {
            res = await fetch(url);
        } catch (e) { lastErr = e; continue; }
        if (res.ok) return res;
        if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise(r => setTimeout(r, Math.min(750 * 2 ** (attempt - 1), 6000) + Math.random() * 300));
    }
    throw lastErr;
}

async function fetchOutfitThumbnails(ids) {
    const map = {};
    let pending = ids.slice();
    for (let round = 0; round < 4 && pending.length > 0; round++) {
        if (round > 0) await new Promise(r => setTimeout(r, 1500));
        const res = await robloxFetch(OUTFIT_THUMBNAILS_API + pending.join(","));
        const data = (await res.json()).data || [];
        pending = [];
        for (const th of data) {
            if (th.state === "Completed" && th.imageUrl) map[th.targetId] = th.imageUrl;
            else if (th.state === "Pending") pending.push(th.targetId);
        }
    }
    return map;
}

async function searchPlayer() {
    const userId = document.getElementById('userIdInput').value.trim();
    const statusText = document.getElementById('statusText');
    const profileContainer = document.getElementById('profileContainer');
    const outfitsContainer = document.getElementById('outfitsContainer');

    if (!userId) return;

    statusText.textContent = "Fetching player data...";
    profileContainer.innerHTML = "";
    outfitsContainer.innerHTML = "";

    try {
        const userRes = await robloxFetch(USERS_API + userId);
        const userData = await userRes.json();

        const thumbRes = await robloxFetch(AVATAR_THUMBNAILS_API + userId);
        const thumbData = await thumbRes.json();
        const avatarImageUrl = thumbData.data[0]?.imageUrl || "";

        profileContainer.innerHTML = `
            <div class="profile-card">
                <h2>${userData.displayName}</h2>
                <p style="color: #aaa;">@${userData.name}</p>
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

async function fetchOutfits(userId) {
    const statusText = document.getElementById('statusText');
    const outfitsContainer = document.getElementById('outfitsContainer');

    statusText.textContent = "Scanning for all outfits... (this might take a moment)";
    outfitsContainer.innerHTML = "";

    try {
        const PER_PAGE = 50;
        let allOutfits = [];
        let page = 1;

        while (true) {
            // NOTE: no isEditable/outfitType params — they aren't valid on this endpoint
            const endpoint = `${AVATAR_API}users/${userId}/outfits?page=${page}&itemsPerPage=${PER_PAGE}`;
            const res = await robloxFetch(endpoint);
            const data = (await res.json()).data || [];

            if (data.length === 0) break;
            allOutfits = allOutfits.concat(data);
            statusText.textContent = `Scanned ${allOutfits.length} outfits...`;
            if (data.length < PER_PAGE) break;
            page++;
        }

        // filter client-side instead
        const outfits = allOutfits.filter(o => o.isEditable);

        if (outfits.length === 0) {
            statusText.textContent = "No saved outfits found.";
            return;
        }

        statusText.textContent = `Found ${outfits.length} custom outfits. Fetching images...`;

        const thumbnailMap = {};
        const chunkSize = 50;
        for (let i = 0; i < outfits.length; i += chunkSize) {
            const chunk = outfits.slice(i, i + chunkSize);
            try {
                Object.assign(thumbnailMap, await fetchOutfitThumbnails(chunk.map(o => o.id)));
            } catch (err) {
                console.warn("A batch of images failed to load.", err);
            }
        }

        statusText.textContent = `Successfully loaded all ${outfits.length} outfits.`;

        outfits.forEach(outfit => {
            const imageUrl = thumbnailMap[outfit.id];
            const outfitDiv = document.createElement('div');
            outfitDiv.className = 'outfit-card';

            let imageHtml = `<p style="color:#666; font-size:12px;">Image Pending</p>`;
            if (imageUrl) {
                imageHtml = `<img class="outfit-thumbnail" src="${imageUrl}" alt="Outfit Image">`;
            }

            outfitDiv.innerHTML = `
                <h3 title="${outfit.name}">${outfit.name}</h3>
                ${imageHtml}
                <div class="action-buttons">
                    <button onclick="fetchAccessories('${outfit.id}', this)">Accessories</button>
                    <button class="copy-btn" onclick="copyAvatarScript('${outfit.id}', this)">Use Avatar</button>
                </div>
                <div id="acc-${outfit.id}" class="accessories-list"></div>
            `;
            outfitsContainer.appendChild(outfitDiv);
        });

    } catch (error) {
        statusText.textContent = "Failed to load outfits — " + error.message;
        console.error(error);
    }
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
        // this endpoint is the most aggressive rate limit of the bunch — extra retries
        const detailsRes = await robloxFetch(AVATAR_API + `outfits/${outfitId}/details`, 8);
        const detailsData = await detailsRes.json();

        let assetsHtml = "<ul>";
        if (detailsData.assets && detailsData.assets.length > 0) {
            detailsData.assets.forEach(asset => {
                assetsHtml += `<li><strong>${asset.name}</strong> <br><span style="color:#888; font-size:12px;">ID: ${asset.id}</span></li>`;
            });
        } else {
            assetsHtml += "<li>No accessories found.</li>";
        }
        assetsHtml += "</ul>";

        accContainer.innerHTML = assetsHtml;
        accContainer.style.display = "block";
        buttonElement.textContent = originalText;

    } catch (error) {
        buttonElement.textContent = "Retry"; // let them click again instead of dead "Error"
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
