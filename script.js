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

// Helper: Query across proxy fallbacks
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
                continue; // Rotate proxy on rate-limit
            }
            if (!res.ok) {
                lastStatus = res.status;
                continue;
            }

            const data = await res.json();
            return data;
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
    throw lastError || new Error("Failed to reach Roblox proxy.");
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

        // Auto-resolve usernames if the user entered a name instead of ID
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

        // 1. Fetch User Info
        const userRes = await fetch(USERS_API + userId);
        if (!userRes.ok) throw new Error("Player not found.");
        const userData = await userRes.json();

        // 2. Fetch User Avatar Image
        let avatarImageUrl = "";
        try {
            const thumbRes = await fetch(AVATAR_THUMBNAILS_API + userId);
            const thumbData = await thumbRes.json();
            avatarImageUrl = thumbData.data?.[0]?.imageUrl || "";
        } catch (_) {}

        // Render Profile Card
        profileContainer.innerHTML = `
            <div class="profile-card">
                <h2>${userData.displayName}</h2>
                <p style="color: #aaa;">@${userData.name} (ID: ${userId})</p>
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
    
    statusText.textContent = "Checking inventory privacy & scanning outfits...";
    outfitsContainer.innerHTML = "";

    try {
        // 1. Verify if the inventory is public
        try {
            const privCheck = await fetch(`${INVENTORY_CHECK_API}${userId}/can-view-inventory`);
            if (privCheck.ok) {
                const privData = await privCheck.json();
                if (privData.canView === false) {
                    statusText.innerHTML = `<span style="color: #ffaa00;">⚠️ This player's inventory is set to <b>Private</b>.<br>Roblox now requires <i>"Who can see my inventory?"</i> to be set to <b>"Everyone"</b> in Roblox Privacy Settings to view outfits.</span>`;
                    return;
                }
            }
        } catch (_) {}

        let allOutfits = [];
        let page = 1;
        let isFetching = true;

        // 2. PAGINATION LOOP (with v1 -> v2 fallback)
        while (isFetching) {
            statusText.textContent = `Scanning outfits (page ${page})...`;
            
            let data = null;
            // Try v1 first
            try {
                data = await fetchWithFallbacks(`v1/users/${userId}/outfits?page=${page}&itemsPerPage=50`);
            } catch (err) {
                if (err.status === 403) throw err;
            }

            // Fallback to v2 if v1 returns empty or fails on page 1
            if ((!data || !data.data || data.data.length === 0) && page === 1) {
                try {
                    data = await fetchWithFallbacks(`v2/avatar/users/${userId}/outfits?page=1&itemsPerPage=50`);
                } catch (_) {}
            }

            const items = Array.isArray(data) ? data : (data?.data || []);

            if (items.length > 0) {
                allOutfits = allOutfits.concat(items);
                statusText.textContent = `Found ${allOutfits.length} outfits...`;

                if (items.length < 50) {
                    isFetching = false;
                } else {
                    page++;
                    await new Promise(r => setTimeout(r, 250)); // Throttling delay
                }
            } else {
                isFetching = false;
            }
        }

        const outfits = allOutfits;

        if (!outfits || outfits.length === 0) {
            statusText.innerHTML = `<span style="color: #ffaa00;">No outfits returned by Roblox.<br>If this user has saved outfits, their Roblox account privacy setting <b>"Who can see my inventory?"</b> is set to Private/Friends. Setting it to <b>"Everyone"</b> on Roblox will allow them to show up.</span>`;
            return;
        }

        statusText.textContent = `Found ${outfits.length} outfits. Fetching images...`;

        const thumbnailMap = {};
        const chunkSize = 50; 

        // 3. Batch thumbnail fetching
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
                console.warn("A batch of images failed to load.", err);
            }
        }

        statusText.textContent = `Successfully loaded ${outfits.length} outfits.`;

        // 4. Render outfit cards
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
        if (error.status === 403) {
            statusText.textContent = "Failed to load outfits: This player's inventory/outfits are set to private.";
        } else if (error.status === 429) {
            statusText.textContent = "Failed to load outfits: Rate limit reached. Please wait a few seconds and try again.";
        } else {
            statusText.textContent = `Failed to load outfits: ${error.message}`;
        }
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
        const detailsData = await fetchWithFallbacks(`v1/outfits/${outfitId}/details`);

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
